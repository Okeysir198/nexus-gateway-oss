"""LangChain agent smoke test against the nexus-gateway Worker.

Proves a real tool-calling agent can drive the proxy end-to-end (model calls a
tool → tool result → final answer) over BOTH client wires:
  • langchain_openai.ChatOpenAI      → OpenAI  /v1/chat/completions  ({BASE}/v1)
  • langchain_anthropic.ChatAnthropic → Anthropic /v1/messages        ({BASE})

Run (from this tests/ dir, the edge reachable):
    RUN_NEXUS_LIVE=1 NEXUS_API_KEY=<your-virtual-key> uv run pytest -v
"""

from langchain.agents import create_agent
from langchain_core.messages import AIMessage, ToolMessage

import pytest

from _client import make_client, multiply


# One canonical (tool-capable) model per provider on the proxy. Model ids use the
# `provider:model` COLON form (the proxy's alias routes); the model path after the
# colon may itself contain '/'. The slash form still routes too, but the clients
# select models by colon now, so the suite exercises the colon aliases.
PROVIDER_MODELS = [
    ("groq", "groq:llama-3.3-70b-versatile"),
    ("openai", "openai:gpt-4o-mini"),
    ("openrouter", "openrouter:nvidia/nemotron-3-nano-30b-a3b:free"),
    ("huggingface", "huggingface:meta-llama/Llama-3.3-70B-Instruct"),
    ("cloudflare", "cf:@cf/zai-org/glm-4.7-flash"),
    ("nvidia_nim", "nvidia_nim:stepfun-ai/step-3.7-flash"),
]

# Every "universal" provider on BOTH wires (OpenAI /chat/completions + Anthropic
# /v1/messages), plus routes that are OpenAI-endpoint-shaped and therefore only work
# on the OpenAI wire (hitting them on /v1/messages makes the Anthropic bridge
# re-translate the tool schema into a form the strict upstream rejects):
#   • zai:*           Z.AI OpenAI coding endpoint            → OpenAI wire only
#   • zai_anthropic:* Z.AI Anthropic endpoint (direct fwd)  → Anthropic wire
# cf:* (Cloudflare OpenAI-compat, glm-4.7-flash = a REASONING model) runs on BOTH wires:
# (1) the route uses /chat/completions, not openai/* (which hits CF's /responses API and
# 400s on the Anthropic bridge); (2) the gateway normalizes the reasoning model's echoed
# `thinking` block into OpenAI form on the Anthropic-wire multi-turn.
_RAW_CASES = [(wire, model) for wire in ("openai", "anthropic") for _, model in PROVIDER_MODELS]
_RAW_CASES += [
    ("openai", "zai:glm-4.6"),
    ("anthropic", "zai_anthropic:glm-4.6"),
]
CASES = [pytest.param(wire, model, id=f"{wire}:{model}") for wire, model in _RAW_CASES]


@pytest.mark.parametrize("wire,model_id", CASES)
def test_agent_tool_call(proxy, wire, model_id):
    base, key = proxy
    model = make_client(wire, model_id, base, key)
    agent = create_agent(model=model, tools=[multiply])

    result = agent.invoke(
        {
            "messages": [
                {
                    "role": "user",
                    # Ask for a full sentence, NOT "just the number": a reasoning
                    # model (e.g. glm-4.6) would otherwise route a bare "42" entirely
                    # into reasoning_content and leave `content` empty. A normal
                    # answer request keeps the reasoning agent working with content
                    # populated.
                    "content": "Use the multiply tool to compute 21 times 2, then "
                    "state the numeric result in a short sentence.",
                }
            ]
        }
    )
    messages = result["messages"]

    # (a) the model actually issued a `multiply` tool call ...
    tool_calls = [
        tc
        for m in messages
        if isinstance(m, AIMessage)
        for tc in (m.tool_calls or [])
    ]
    assert any(tc["name"] == "multiply" for tc in tool_calls), (
        f"[{wire}:{model_id}] no multiply tool call in: {tool_calls}"
    )

    # ... and the tool returned 42
    tool_results = [m for m in messages if isinstance(m, ToolMessage)]
    assert any("42" in str(m.content) for m in tool_results), (
        f"[{wire}:{model_id}] tool result != 42: {[m.content for m in tool_results]}"
    )

    # (b) the final assistant answer contains 42
    final = next(m for m in reversed(messages) if isinstance(m, AIMessage))
    final_text = str(final.content)
    assert "42" in final_text, f"[{wire}:{model_id}] final answer lacks 42: {final_text!r}"
