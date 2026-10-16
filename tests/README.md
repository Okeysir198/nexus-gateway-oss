# nexus-gateway live smoke tests

Python tests that drive a LangChain `create_agent` tool-calling loop (model, tool_call,
tool_result, final answer) through a running nexus-gateway Worker on **both** client wires:
`langchain_openai.ChatOpenAI` (OpenAI `/v1/chat/completions`) and
`langchain_anthropic.ChatAnthropic` (Anthropic `/v1/messages`).

They need a reachable edge: `npx wrangler dev` (the default `NEXUS_BASE` is
`http://127.0.0.1:8787`) or a deployed Worker (`NEXUS_BASE=https://<your-host>`), plus a
virtual key minted from the console.

## Run

```bash
cd tests
uv sync                                       # one-time, creates tests/.venv
RUN_NEXUS_LIVE=1 NEXUS_API_KEY=<your-virtual-key> uv run python -m pytest -v
```

Without `RUN_NEXUS_LIVE=1` the suite skips. An unreachable edge skips too (not errors).
Use `uv run python -m pytest`, not `uv run pytest`: the bare entry point can resolve to an
interpreter that does not see the project `.venv`.

The cases run concurrently (`addopts = -n auto`, pytest-xdist); each is a full agent loop of
two or more sequential LLM turns, so wall time floors at the slowest single test. Use `-n 0`
to run serially.

## Interactive chat (`chat.py`)

A REPL agent for trying models and flipping the wire format live:

```bash
NEXUS_API_KEY=<your-virtual-key> uv run python chat.py          # menu
NEXUS_API_KEY=<your-virtual-key> uv run python chat.py groq     # start on a model
```

- **Memory:** the LangGraph checkpointer (`InMemorySaver` plus a `thread_id`) keeps the
  whole multi-turn conversation, tool calls included; switching models keeps the thread.
- **Tools:** `multiply`, `add`, `get_weather` (demo); calls and results are shown.
- **Any model:** `/model <upstream-model-id> [openai|anthropic]` sends an arbitrary model id
  straight to the gateway; `/model <preset-key>` picks a preset; `/model` alone opens the
  menu.
- **Reasoning control:** `/reason off` disables thinking, `/reason <budget_tokens>` caps
  it, `/reason on` restores the model default. The disable knob depends on the route, not
  the model name:

  | Route | Disable knob |
  |---|---|
  | `zai/*`, `zai_anthropic/*` | `thinking: {type: disabled}` |
  | `openrouter/*` | `reasoning: {enabled: false}` (`{max_tokens: N}` for a budget) |
  | `cf/*`, `nvidia_nim/*`, vLLM-style `nemotron`/`qwen` | `chat_template_kwargs: {enable_thinking: false}` |
  | groq / openai (non-reasoning models) | no-op |

  Construction lives in `_client.py::make_client(..., thinking=...)`, shared with the test
  suite. Unknown families are a safe no-op, because strict endpoints 400 on unrecognised
  parameters.
- **Commands:** `/models`, `/model`, `/wire [openai|anthropic]`, `/reason`, `/reset`,
  `/think` (show or hide the reasoning stream), `/help`, `/quit`.
