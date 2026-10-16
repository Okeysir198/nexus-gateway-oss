import { describe, expect, it } from "vitest";
import { anthropicToOpenAIRequest } from "../src/translate/a2o_request";
import { openaiToAnthropicUsage, openaiToAnthropicResponse } from "../src/translate/o2a_response";
import type { AnthropicMessagesRequest } from "../src/types";

/** Prompt caching across the translation hop.
 *
 *  Caching was silently impossible on every translated route, for two independent reasons,
 *  and both failed QUIETLY — the request looked fine, the response looked fine, and the
 *  only symptom was a bill.
 *
 *  1. The request flattened content blocks into one joined string, and `cache_control` is
 *     a property of a BLOCK, so every caller's breakpoints were deleted in transit.
 *  2. The response mapped only `prompt_tokens`/`completion_tokens`, so a cache hit was
 *     invisible even when it happened.
 *
 *  Observed through a live gateway on a Qwen model: with the breakpoint preserved, most
 *  of a repeated prompt came back as `cached_tokens`. */

const req = (extra: Record<string, unknown>): AnthropicMessagesRequest => ({
  model: "qwen/qwen3.7-flash",
  max_tokens: 16,
  messages: [{ role: "user", content: "hi" }],
  ...extra,
} as AnthropicMessagesRequest);

describe("cache breakpoints survive the request hop", () => {
  it("keeps cache_control on a system block, as an array", () => {
    const out = anthropicToOpenAIRequest(
      req({ system: [{ type: "text", text: "big reusable preamble",
                       cache_control: { type: "ephemeral" } }] }),
      "qwen/qwen3.7-flash", undefined);
    const sys = out.messages?.[0];
    expect(Array.isArray(sys?.content)).toBe(true);
    expect((sys?.content as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: "text", text: "big reusable preamble", cache_control: { type: "ephemeral" },
    });
  });

  it("keeps cache_control on a user message block", () => {
    const out = anthropicToOpenAIRequest(
      req({ messages: [{ role: "user", content: [
        { type: "text", text: "stable", cache_control: { type: "ephemeral" } },
        { type: "text", text: " dynamic" }] }] }),
      "qwen/qwen3.7-flash", undefined);
    const parts = out.messages?.[0]?.content as Array<Record<string, unknown>>;
    expect(Array.isArray(parts)).toBe(true);
    expect(parts.map((p) => p.text)).toEqual(["stable", " dynamic"]);
    expect(parts[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(parts[1]!.cache_control).toBeUndefined();
  });

  it("still sends a PLAIN STRING when nothing is cached", () => {
    // The overwhelming majority of traffic, and the shape every upstream has always
    // accepted — a fix that changed this for everyone would be a much riskier change.
    const out = anthropicToOpenAIRequest(
      req({ system: [{ type: "text", text: "a" }, { type: "text", text: "b" }],
            messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] }),
      "qwen/qwen3.7-flash", undefined);
    expect(out.messages?.[0]?.content).toBe("ab");
    expect(out.messages?.[1]?.content).toBe("hi");
  });
});

describe("usage mapping de-overlaps the cache counters", () => {
  it("subtracts cached tokens from input_tokens", () => {
    // ⚠️ The two wires disagree: `cached_tokens` is a SUBSET of `prompt_tokens`, while
    // Anthropic's `cache_read_input_tokens` is DISJOINT from `input_tokens`. Verified on
    // the live edge — the same prompt three times held `prompt_tokens` at 5,968 while
    // `cached_tokens` went 0 → 4,352 → 0. Copying it across unchanged double-counts every
    // cached token in any consumer that sums the three.
    expect(openaiToAnthropicUsage({
      prompt_tokens: 5968, completion_tokens: 16,
      prompt_tokens_details: { cached_tokens: 4352, cache_write_tokens: 0 },
    })).toEqual({
      input_tokens: 1616, output_tokens: 16,
      cache_read_input_tokens: 4352, cache_creation_input_tokens: 0,
    });
  });

  it("subtracts cache WRITES too", () => {
    expect(openaiToAnthropicUsage({
      prompt_tokens: 1000, completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: 200, cache_write_tokens: 300 },
    })).toMatchObject({ input_tokens: 500, cache_creation_input_tokens: 300 });
  });

  it("reports NOTHING about caching when the upstream said nothing", () => {
    // Unknown is not zero. A confident 0 is how "caching does not work on this route"
    // became folklore across 785 recorded turns.
    const u = openaiToAnthropicUsage({ prompt_tokens: 100, completion_tokens: 2 });
    expect(u).toEqual({ input_tokens: 100, output_tokens: 2 });
    expect("cache_read_input_tokens" in u).toBe(false);
  });

  it("never returns a negative input_tokens if an upstream over-reports", () => {
    expect(openaiToAnthropicUsage({
      prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 99 },
    }).input_tokens).toBe(0);
  });

  it("is wired into the non-streaming response", () => {
    const { body } = openaiToAnthropicResponse({
      id: "x", model: "m", choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 500, completion_tokens: 7,
               prompt_tokens_details: { cached_tokens: 400 } },
    });
    expect(body.usage).toMatchObject({ input_tokens: 100, cache_read_input_tokens: 400 });
  });
});

describe("streamed translated responses must be able to report usage", () => {
  it("asks for usage on a stream", () => {
    // A streamed OpenAI response carries NO usage unless requested, while the Anthropic
    // wire always reports it — so without this every streamed translated turn reported
    // zero tokens and $0.00, which reads as free rather than as unknown.
    const out = anthropicToOpenAIRequest(
      { model: "m", max_tokens: 16, stream: true,
        messages: [{ role: "user", content: "hi" }] } as never,
      "qwen/qwen3.7-flash", undefined);
    expect((out as Record<string, unknown>).stream_options).toEqual({ include_usage: true });
  });

  it("does not add it to a NON-streamed request", () => {
    const out = anthropicToOpenAIRequest(
      { model: "m", max_tokens: 16,
        messages: [{ role: "user", content: "hi" }] } as never,
      "qwen/qwen3.7-flash", undefined);
    expect((out as Record<string, unknown>).stream_options).toBeUndefined();
  });

  it("never overrides a caller's own stream_options", () => {
    const out = anthropicToOpenAIRequest(
      { model: "m", max_tokens: 16, stream: true, stream_options: { include_usage: false },
        messages: [{ role: "user", content: "hi" }] } as never,
      "qwen/qwen3.7-flash", undefined);
    expect((out as Record<string, unknown>).stream_options).toEqual({ include_usage: false });
  });
});
