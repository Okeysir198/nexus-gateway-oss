"""Interactive agent chat against a nexus-gateway Worker.

Pick a model from any wired provider (Groq / OpenAI / OpenRouter / HF / NVIDIA NIM /
Z.AI / Cloudflare), chat multi-turn with tool-calling, and switch models
mid-conversation. Every model is reached through the ONE proxy endpoint on
NEXUS_API_KEY — OpenAI-wire models via `ChatOpenAI`, Anthropic-wire via
`ChatAnthropic`.

Memory: uses `create_agent`'s native LangGraph checkpointer (InMemorySaver) keyed by a
`thread_id`, so the agent remembers the whole conversation (including tool calls) across
turns — you just send the new message each turn. Switching models keeps the same thread,
so history carries over.

Run (from this tests/ dir, the Worker must be up; default NEXUS_BASE is `wrangler dev`):
    NEXUS_API_KEY=<your-virtual-key> uv run python chat.py
    uv run python chat.py groq            # start on a model by its key

Commands:
    /models                    list models
    /model [key]               switch model (menu if no key); conversation is kept
    /wire [openai|anthropic]   change the wire FORMAT for the current model (no arg = toggle)
    /reset                     start a fresh conversation (new memory thread)
    /think                     toggle showing the reasoning (thinking) stream (default ON)
    /help                      show commands
    /quit  /exit               leave
"""

from __future__ import annotations

import sys

from langchain.agents import create_agent
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langgraph.checkpoint.memory import InMemorySaver
from rich.console import Console
from rich.table import Table

from _client import BASE, DEMO_TOOLS, KEY, make_client

console = Console(highlight=False)

# ── model catalog (key, label, wire, upstream model id) — all verified working ──
MODELS: list[dict] = [
    {"key": "groq",       "label": "Llama 3.3 70B (Groq)",              "wire": "openai",    "model": "groq:llama-3.3-70b-versatile"},
    {"key": "gpt4o-mini", "label": "GPT-4o mini (OpenAI)",              "wire": "openai",    "model": "openai:gpt-4o-mini"},
    {"key": "or-nemo",    "label": "Nemotron-3-Nano free (OpenRouter)", "wire": "openai",    "model": "openrouter:nvidia/nemotron-3-nano-30b-a3b:free"},
    {"key": "hf-llama",   "label": "Llama 3.3 70B (HuggingFace)",       "wire": "openai",    "model": "huggingface:meta-llama/Llama-3.3-70B-Instruct"},
    {"key": "step",       "label": "Step 3.7 Flash (NVIDIA NIM)",       "wire": "openai",    "model": "nvidia_nim:stepfun-ai/step-3.7-flash"},
    {"key": "zai",        "label": "GLM-4.6 (Z.AI, OpenAI endpoint)",   "wire": "openai",    "model": "zai:glm-4.6"},
    {"key": "zai-anth",   "label": "GLM-4.6 (Z.AI, Anthropic endpoint)","wire": "anthropic", "model": "zai_anthropic:glm-4.6"},
    {"key": "cf-glm",     "label": "GLM-4.7-flash (Cloudflare)",        "wire": "openai",    "model": "cf:@cf/zai-org/glm-4.7-flash"},
    {"key": "cf-glm-anth","label": "GLM-4.7-flash (Cloudflare, Anthropic wire)", "wire": "anthropic", "model": "cf:@cf/zai-org/glm-4.7-flash"},
]
BY_KEY = {m["key"]: m for m in MODELS}


def build_model(entry: dict, wire: str | None = None, thinking=None):
    """Build the chat client. `wire` overrides the model's default wire (openai|anthropic);
    `thinking` controls reasoning (None=default, "off"=disable, int=budget tokens).

    Both surfaces hit the SAME proxy: OpenAI wire → {BASE}/v1/chat/completions,
    Anthropic wire → {BASE}/v1/messages. A model reachable on both wires (e.g. cf:*,
    groq:…, openai:…) can be flipped live; endpoint-specific routes (zai:* vs
    zai_anthropic:*) are different model ids — switch those with /model.
    """
    wire = wire or entry["wire"]
    return make_client(wire, entry["model"], BASE, KEY, max_tokens=2048, thinking=thinking)


def print_models(current: dict | None = None) -> None:
    t = Table(title="Models on the nexus-gateway Worker", title_style="bold cyan")
    t.add_column("key", style="green")
    t.add_column("model")
    t.add_column("wire", style="dim")
    for m in MODELS:
        mark = "→ " if current and m is current else "  "
        t.add_row(mark + m["key"], f"{m['label']}\n[dim]{m['model']}[/]", m["wire"])
    console.print(t)


def choose_model(default_key: str | None = None) -> dict:
    print_models()
    default = default_key or MODELS[0]["key"]
    while True:
        key = console.input(f"[bold]pick a model key[/] ([green]{default}[/]): ").strip() or default
        if key in BY_KEY:
            return BY_KEY[key]
        console.print(f"[red]unknown key {key!r}[/] — see the list above")


def _iter_text_thinking(content):
    """Yield (kind, text) from a chunk's content — kind is 'text' or 'thinking'.

    OpenAI-wire chunks give a plain string; Anthropic-wire (reasoning) chunks give a
    list of {type: text|thinking, ...} blocks.
    """
    if isinstance(content, str):
        if content:
            yield "text", content
    elif isinstance(content, list):
        for block in content:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "text" and block.get("text"):
                yield "text", block["text"]
            elif block.get("type") == "thinking" and block.get("thinking"):
                yield "thinking", block["thinking"]


def render_stream(agent, user_text: str, config: dict, show_thinking: bool) -> None:
    """Stream ONE turn (native memory via checkpointer); print tools + tokens."""
    # markup=False everywhere for model-generated text — it may contain '[' / '[/]'
    # that rich would try (and fail) to parse as markup.
    reply_started = False
    thinking_started = False
    for ev_type, payload in agent.stream(
        {"messages": [HumanMessage(user_text)]}, config, stream_mode=["messages", "updates"]
    ):
        if ev_type == "messages":
            chunk, meta = payload
            if meta.get("langgraph_node") != "model":
                continue
            # OpenAI wire streams reasoning in additional_kwargs.reasoning_content
            # (Anthropic wire carries it as a content 'thinking' block, handled below).
            rc = chunk.additional_kwargs.get("reasoning_content")
            parts = ([("thinking", rc)] if rc else []) + list(_iter_text_thinking(chunk.content))
            for kind, text in parts:
                if kind == "thinking":
                    if not show_thinking:
                        continue
                    if not thinking_started:
                        console.print("💭 ", end="", style="dim", markup=False)
                        thinking_started = True
                    console.print(text, end="", style="dim", markup=False)
                else:  # text
                    if thinking_started:
                        console.print(); thinking_started = False  # close the thinking line
                    if not reply_started:
                        console.print("🤖 ", end="", style="bold magenta", markup=False)
                        reply_started = True
                    console.print(text, end="", style="magenta", markup=False)
        elif ev_type == "updates":
            for _, diff in payload.items():
                for msg in (diff or {}).get("messages", []) or []:
                    if isinstance(msg, AIMessage):
                        for c in msg.tool_calls or []:
                            args = ", ".join(f"{k}={v!r}" for k, v in c["args"].items())
                            console.print(f"🛠  {c['name']}({args})", style="yellow", markup=False)
                    elif isinstance(msg, ToolMessage):
                        console.print(f"   ↳ {msg.content}", style="dim yellow", markup=False)
    if reply_started or thinking_started:
        console.print()  # newline after the streamed reply


HELP = """[bold]commands[/]
  [green]/models[/]                       list preset models
  [green]/model [key][/]                  switch to a preset (menu if no key); keeps the conversation
  [green]/model <model-id> [wire][/]      use ANY upstream model id directly (not just presets),
                                 e.g. /model cf:@cf/meta/llama-4-scout-17b-16e-instruct openai
                                 wire defaults to the current one.
  [green]/wire [openai|anthropic][/]      change the wire FORMAT for the current model (no arg = toggle)
  [green]/reason [on|off|<budget>][/]     control the model's THINKING: off = disable, a number = budget
                                 tokens (mapped per family), on/blank = model default
  [green]/reset[/]                        start a fresh conversation (new memory thread)
  [green]/think[/]                        toggle SHOWING the reasoning stream (display only)
  [green]/help[/]                         this help
  [green]/quit[/] /exit                   leave"""


def main() -> None:
    arg0 = sys.argv[1] if len(sys.argv) > 1 else None
    console.print("[bold cyan]Interactive agent chat[/] — nexus-gateway Worker  "
                  "[dim](key from NEXUS_API_KEY)[/]")
    entry = BY_KEY[arg0] if arg0 in BY_KEY else choose_model()

    memory = InMemorySaver()               # native create_agent conversation memory
    thread = 1
    show_thinking = True                    # render the reasoning stream by default
    cur_wire = entry["wire"]                # live wire override (openai|anthropic)
    cur_thinking = None                     # reasoning control: None | "off" | int budget

    def new_agent():
        return create_agent(model=build_model(entry, cur_wire, cur_thinking),
                            tools=DEMO_TOOLS, checkpointer=memory)

    agent = new_agent()
    console.print(f"using [green]{entry['key']}[/] · {entry['label']}  [dim]({cur_wire} wire)[/]")
    console.print("[dim]/help for commands[/]")

    while True:
        try:
            user = console.input("\n[bold green]you ›[/] ").strip()
        except (EOFError, KeyboardInterrupt):
            console.print("\nbye"); return
        if not user:
            continue

        if user in ("/quit", "/exit"):
            console.print("bye"); return
        if user == "/help":
            console.print(HELP); continue
        if user == "/models":
            print_models(entry); continue
        if user == "/think":
            show_thinking = not show_thinking
            console.print(f"[dim]thinking stream {'ON' if show_thinking else 'OFF'}[/]"); continue
        if user == "/reset":
            thread += 1  # new thread_id ⇒ fresh memory
            console.print("[dim]new conversation started[/]"); continue
        if user.startswith("/reason"):
            arg = user.removeprefix("/reason").strip().lower()
            if arg in ("", "on", "default", "auto"):
                cur_thinking, label = None, "default"
            elif arg == "off":
                cur_thinking, label = "off", "off"
            elif arg.isdigit():
                cur_thinking, label = int(arg), f"budget={arg}"
            else:
                console.print("[red]usage:[/] /reason [on|off|<budget_tokens>]"); continue
            agent = new_agent()
            console.print(f"[dim]reasoning → [/][green]{label}[/][dim] — applies next turn[/]")
            continue
        if user.startswith("/wire"):
            arg = user.removeprefix("/wire").strip().lower()
            target = arg or ("anthropic" if cur_wire == "openai" else "openai")  # toggle
            if target not in ("openai", "anthropic"):
                console.print("[red]usage:[/] /wire [openai|anthropic]"); continue
            cur_wire = target
            agent = new_agent()  # same model id, other client; memory kept
            console.print(f"[dim]wire → [/][green]{cur_wire}[/][dim]  "
                          f"({'/v1/messages' if cur_wire == 'anthropic' else '/v1/chat/completions'}) "
                          f"— if the model isn't valid on this wire the next turn will error[/]")
            continue
        if user.startswith("/model"):
            toks = user.removeprefix("/model").strip().split()
            if not toks:                                   # no arg → menu
                entry = choose_model(entry["key"])
            elif toks[0] in BY_KEY:                         # preset key
                entry = BY_KEY[toks[0]]
            else:                                           # arbitrary upstream model id
                w = (toks[1].lower() if len(toks) > 1 and toks[1].lower() in ("openai", "anthropic")
                     else cur_wire)
                entry = {"key": "custom", "label": toks[0], "wire": w, "model": toks[0]}
            cur_wire = entry["wire"]   # follow the selected model's wire
            agent = new_agent()  # same checkpointer + thread ⇒ history carries over
            console.print(f"switched to [green]{entry['key']}[/] · {entry['label']} "
                          f"[dim]({cur_wire} wire)[/] — memory kept")
            continue

        config = {"configurable": {"thread_id": f"chat-{thread}"}}
        try:
            render_stream(agent, user, config, show_thinking)
        except Exception as e:  # noqa: BLE001 — surface upstream errors, keep REPL alive
            console.print(f"[red]error:[/] {str(e)[:400]}")


if __name__ == "__main__":
    main()
