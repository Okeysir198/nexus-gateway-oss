"""Shared LangChain client builder for the nexus-gateway tests + REPL.

Both surfaces hit the SAME proxy on NEXUS_API_KEY:
  • openai    wire → ChatOpenAI   posts to {base}/v1/chat/completions
  • anthropic wire → ChatAnthropic posts to {base}/v1/messages

max_tokens is roomy so reasoning models (Nemotron etc.) aren't truncated
mid-thought before they emit the tool call / final answer.

Reasoning control (`thinking` arg) — disable thinking or cap its budget. Each family
exposes it via different BODY params, but the params ride in the request body on BOTH
wires (ChatOpenAI `extra_body=`, ChatAnthropic `extra_body=` via model_kwargs), so a
vLLM/Nemotron model can be silenced on the Anthropic wire too:
  • thinking=None  → leave the model default
  • thinking="off" → disable reasoning
  • thinking=<int> → cap the reasoning budget to N tokens (where the family supports it)
"""

from __future__ import annotations

import os
from typing import Union

from langchain_anthropic import ChatAnthropic
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI

Thinking = Union[None, str, int]   # None | "off" | budget-tokens int

# Proxy connection defaults — single source for the REPL, conftest, and tests.
# Defaults to `wrangler dev`. Point NEXUS_BASE at a deployed Worker to test it.
BASE = os.getenv("NEXUS_BASE", "http://127.0.0.1:8787")
KEY = os.getenv("NEXUS_API_KEY", "")


# ── demo tools (shared by the REPL + smoke test so schemas never drift) ───────
@tool
def multiply(a: int, b: int) -> int:
    """Multiply two integers."""
    return a * b


@tool
def add(a: int, b: int) -> int:
    """Add two integers."""
    return a + b


@tool
def get_weather(city: str) -> str:
    """Get the current weather for a city (demo data)."""
    return f"{city}: 24°C, partly cloudy, light wind."


DEMO_TOOLS = [multiply, add, get_weather]


def _reasoning_dialect(model_id: str) -> Union[str, None]:
    """Which reasoning-control dialect a route speaks — keyed by the ROUTE (how the
    model is hosted), not the model name: the same family disables differently per host.
    Ordered by specificity (host prefix wins over family substring, so e.g.
    `openrouter/nvidia/nemotron-…` resolves to 'openrouter', not 'vllm').

      • 'zai'        z.ai native GLM (zai/*, zai_anthropic/*)
      • 'openrouter' OpenRouter's unified reasoning API (it normalizes/drops raw params)
      • 'vllm'       vLLM-served (cf/*, nvidia_nim/*, or any nemotron/qwen)

    Returns None for non-reasoning routes (groq/openai/hf llama, …) ⇒ /reason is a no-op.
    """
    m = model_id.lower()
    # The provider prefix is the token before the first ':' OR '/'. Both separators
    # route on the gateway (`provider:model` colon aliases + the native
    # `provider/model` slash routes), so accept either here.
    seps = [i for i in (m.find(":"), m.find("/")) if i != -1]
    prefix = m[: min(seps)] if seps else m
    if prefix in ("zai", "zai_anthropic"):
        return "zai"
    if prefix == "openrouter":
        return "openrouter"
    if prefix in ("cf", "nvidia_nim") or "nemotron" in m or "qwen" in m:
        return "vllm"
    return None


def _thinking_body(model_id: str, thinking: Thinking) -> dict:
    """Request-body params to control reasoning, by the route's dialect. We only ever
    emit knobs the route is known to accept — a chat_template kwarg a non-thinking model
    ignores is harmless, but an unknown top-level param (e.g. reasoning_effort) 400s a
    strict endpoint like Cloudflare. NOTE: step-3.7-flash on NVIDIA NIM ignores the vLLM
    knob (NIM exposes no disable for it) — a known no-op, not a client-fixable bug.
    """
    if thinking is None:
        return {}
    off = thinking == "off"
    dialect = _reasoning_dialect(model_id)
    if dialect == "zai":
        return {"thinking": {"type": "disabled" if off else "enabled"}}
    if dialect == "openrouter":
        if off:
            return {"reasoning": {"enabled": False}}
        if isinstance(thinking, int):
            return {"reasoning": {"max_tokens": thinking}}
        return {"reasoning": {"enabled": True}}
    if dialect == "vllm":
        body: dict = {"chat_template_kwargs": {"enable_thinking": not off}}
        if isinstance(thinking, int):
            body["reasoning_budget"] = thinking
        return body
    return {}


def make_client(wire: str, model_id: str, base: str, key: str,
                max_tokens: int = 1024, thinking: Thinking = None):
    body = _thinking_body(model_id, thinking)
    if wire == "openai":
        return ChatOpenAI(
            model=model_id, api_key=key, base_url=f"{base}/v1",
            temperature=0, max_tokens=max_tokens,
            extra_body=body or None,
        )
    # Anthropic wire: ride the same body params through anthropic's `extra_body`
    # (the anthropic SDK merges it into the /v1/messages request → reaches the
    # upstream via the proxy's bridge). model_kwargs is how langchain_anthropic
    # forwards SDK create() kwargs.
    model_kwargs = {"extra_body": body} if body else {}
    return ChatAnthropic(
        model=model_id, anthropic_api_key=key, anthropic_api_url=base,
        temperature=0, max_tokens=max_tokens, model_kwargs=model_kwargs,
    )
