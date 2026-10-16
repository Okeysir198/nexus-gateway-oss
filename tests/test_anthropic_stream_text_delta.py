"""Regression: the Anthropic STREAMING wire must not drop a text block's first chunk.

The `/v1/messages` streaming adapter emits `content_block_stop` +
`content_block_start` for the chunk that switches content blocks (thinking -> text) and
then discards that chunk's own delta, believing `content_block_start` carries the text.
It does not — it is built with `text: ""`. The first token(s) of the visible answer were
silently lost: `IOS-PRG-0185` arrived as `OS-PRG-0185`.

`patches/fix_anthropic_stream_text_delta.py` (applied in the Dockerfile) re-queues the
trigger chunk for `text_delta`, mirroring what upstream already does for
`input_json_delta`.

Guard against BOTH failure modes:
  * text lost  -> streamed text != non-streamed text
  * text duped -> a naive fix that emits the trigger chunk twice

Reasoning models are the ones that hit this (they open a `thinking` block first, so a
block transition always happens), hence the model choices below.

Run: RUN_NEXUS_LIVE=1 NEXUS_API_KEY=... uv run pytest test_anthropic_stream_text_delta.py -v
"""

from __future__ import annotations

import json

import httpx
import pytest

# Models that open a thinking block before their text block -> exercise the transition.
REASONING_MODELS = [
    "nvidia_nim:nvidia/nemotron-3-nano-30b-a3b",
    "nvidia_nim:stepfun-ai/step-3.7-flash",
]

_PROMPT = "Reply with exactly this and nothing else: IOS-PRG-0185 is the answer."
_EXPECTED = "IOS-PRG-0185"


def _body(model: str, *, stream: bool) -> dict:
    return {
        "model": model,
        "max_tokens": 600,
        "stream": stream,
        "messages": [{"role": "user", "content": _PROMPT}],
    }


def _headers(key: str) -> dict:
    return {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
    }


def _streamed_text(base: str, key: str, model: str) -> str:
    out: list[str] = []
    with httpx.Client(timeout=httpx.Timeout(None, connect=15.0, read=120.0)) as http:
        with http.stream("POST", f"{base}/v1/messages",
                         headers=_headers(key), json=_body(model, stream=True)) as r:
            r.raise_for_status()
            for line in r.iter_lines():
                line = line.strip()
                if not line.startswith("data:"):
                    continue
                try:
                    event = json.loads(line[5:].strip())
                except json.JSONDecodeError:
                    continue
                if event.get("type") != "content_block_delta":
                    continue
                delta = event.get("delta") or {}
                if delta.get("type") == "text_delta":
                    out.append(delta.get("text") or "")
    return "".join(out)


def _blocking_text(base: str, key: str, model: str) -> str:
    r = httpx.post(f"{base}/v1/messages", headers=_headers(key),
                   json=_body(model, stream=False), timeout=120.0)
    r.raise_for_status()
    return "".join(b.get("text") or "" for b in r.json().get("content", [])
                   if b.get("type") == "text")


@pytest.mark.parametrize("model", REASONING_MODELS)
def test_streamed_text_is_not_truncated(proxy, model):
    """The streamed text must contain the full token, not a prefix-shorn one."""
    base, key = proxy
    streamed = _streamed_text(base, key, model)

    assert _EXPECTED in streamed, (
        f"{model}: streamed text lost its opening chunk -> {streamed!r}. "
        "The Dockerfile patch (patches/fix_anthropic_stream_text_delta.py) is missing "
        "or upstream regressed."
    )
    # A trigger chunk emitted twice would duplicate the opening token.
    assert streamed.count(_EXPECTED) == 1, f"{model}: text duplicated -> {streamed!r}"


@pytest.mark.parametrize("model", REASONING_MODELS)
def test_streamed_matches_blocking(proxy, model):
    """Streaming and non-streaming must agree — non-streaming was never affected."""
    base, key = proxy
    assert _streamed_text(base, key, model).strip() == _blocking_text(base, key, model).strip()
