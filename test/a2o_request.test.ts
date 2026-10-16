import { describe, expect, it } from "vitest";
import { anthropicToOpenAIRequest } from "../src/translate/a2o_request";
import type { AnthropicMessagesRequest } from "../src/types";

/** Which Anthropic-wire fields survive the hop to an OpenAI-compat upstream.
 *
 *  The conversion spreads the whole request body, so anything the deny-list misses is
 *  forwarded verbatim. Strict upstreams 400 on unknown fields instead of ignoring them:
 *  Claude Code started sending `output_config` + `context_management`, and the NVIDIA-NIM
 *  route died with "Validation: Unsupported parameter(s)" on every call.
 *
 *  The other half matters just as much — the deny-list must NOT become an allow-list,
 *  because unknown-but-intentional extras (`chat_template_kwargs` for
 *  self-hosted llama.cpp-style servers) have to reach the upstream untouched. */

const base = (extra: Record<string, unknown> = {}): AnthropicMessagesRequest => ({
  model: "minimaxai/minimax-m3",
  max_tokens: 16,
  messages: [{ role: "user", content: "hi" }],
  ...extra,
});

describe("anthropicToOpenAIRequest — Anthropic-only fields", () => {
  it("drops the fields that broke the NIM route", () => {
    const out = anthropicToOpenAIRequest(
      base({ output_config: { foo: 1 }, context_management: { bar: 2 } }),
      "minimaxai/minimax-m3",
      undefined,
    ) as Record<string, unknown>;

    expect(out).not.toHaveProperty("output_config");
    expect(out).not.toHaveProperty("context_management");
  });

  it("drops the remaining Anthropic-only fields", () => {
    const out = anthropicToOpenAIRequest(
      base({
        system: "be brief",
        anthropic_version: "2023-06-01",
        anthropic_beta: ["x"],
        mcp_servers: [],
        container: "c",
      }),
      "m",
      undefined,
    ) as Record<string, unknown>;

    for (const k of ["system", "anthropic_version", "anthropic_beta", "mcp_servers", "container"]) {
      expect(out).not.toHaveProperty(k);
    }
  });

  it("lifts system into a leading system message rather than losing it", () => {
    const out = anthropicToOpenAIRequest(base({ system: "be brief" }), "m", undefined);
    expect(out.messages?.[0]).toEqual({ role: "system", content: "be brief" });
  });

  it("passes unknown provider extras through — deny-list, not allow-list", () => {
    const out = anthropicToOpenAIRequest(
      base({ chat_template_kwargs: { enable_thinking: false }, temperature: 0.2 }),
      "m",
      undefined,
    ) as Record<string, unknown>;

    expect(out.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(out.temperature).toBe(0.2);
  });

  it("keeps the standard OpenAI fields it is supposed to forward", () => {
    const out = anthropicToOpenAIRequest(base({ stream: true }), "resolved-id", undefined);
    expect(out.model).toBe("resolved-id");
    expect(out.stream).toBe(true);
    expect(out.max_tokens).toBe(16);
  });
});

/** A `system` message that is not FIRST breaks reasoning separation on some upstreams.
 *
 *  Claude Code appends one on every call (agent listing + skill listing + token budget),
 *  after the user turn, so the OpenAI body ended `[system, user, system]`. Observed
 *  on a DeepSeek-V4 route: with it, `reasoning_content` came back empty and the
 *  chain-of-thought was inlined into `content`; folded into the leading system message,
 *  `reasoning_content` was populated. `o2a_response` then has no
 *  reasoning to map to a `thinking` block, so the caller renders the model's reasoning
 *  as a plain assistant message. */
describe("anthropicToOpenAIRequest — non-leading system messages", () => {
  const withTrailingSystem = (extra: Record<string, unknown> = {}) =>
    anthropicToOpenAIRequest(
      {
        model: "m",
        max_tokens: 16,
        system: "top-level prompt",
        messages: [
          { role: "user", content: "hi" },
          { role: "system", content: "agent listing" },
        ],
        ...extra,
      } as AnthropicMessagesRequest,
      "m",
      undefined,
    );

  it("folds a trailing system message into the leading one", () => {
    const out = withTrailingSystem();
    expect(out.messages).toEqual([
      { role: "system", content: "top-level prompt\n\nagent listing" },
      { role: "user", content: "hi" },
    ]);
  });

  it("leaves no system role anywhere but position 0", () => {
    const msgs = withTrailingSystem().messages ?? [];
    expect(msgs.slice(1).some((m) => m.role === "system")).toBe(false);
  });

  it("preserves the order of several interleaved system messages", () => {
    const out = anthropicToOpenAIRequest(
      {
        model: "m",
        max_tokens: 16,
        system: "A",
        messages: [
          { role: "system", content: "B" },
          { role: "user", content: "u1" },
          { role: "system", content: "C" },
          { role: "assistant", content: "a1" },
          { role: "system", content: "D" },
        ],
      } as AnthropicMessagesRequest,
      "m",
      undefined,
    );
    expect(out.messages).toEqual([
      { role: "system", content: "A\n\nB\n\nC\n\nD" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
    ]);
  });

  it("synthesizes a leading system message when the request has no top-level system", () => {
    const out = anthropicToOpenAIRequest(
      {
        model: "m",
        max_tokens: 16,
        messages: [
          { role: "user", content: "hi" },
          { role: "system", content: "agent listing" },
        ],
      } as AnthropicMessagesRequest,
      "m",
      undefined,
    );
    expect(out.messages).toEqual([
      { role: "system", content: "agent listing" },
      { role: "user", content: "hi" },
    ]);
  });

  it("does not touch a body whose only system message is already leading", () => {
    const out = anthropicToOpenAIRequest(
      {
        model: "m",
        max_tokens: 16,
        system: "be brief",
        messages: [{ role: "user", content: "hi" }],
      } as AnthropicMessagesRequest,
      "m",
      undefined,
    );
    expect(out.messages).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
    ]);
  });

  it("keeps a cache_control breakpoint as its own PART through the fold", () => {
    const out = anthropicToOpenAIRequest(
      {
        model: "m",
        max_tokens: 16,
        system: [
          { type: "text", text: "cached prefix", cache_control: { type: "ephemeral" } },
        ],
        messages: [
          { role: "user", content: "hi" },
          { role: "system", content: "agent listing" },
        ],
      } as unknown as AnthropicMessagesRequest,
      "m",
      undefined,
    );
    expect(out.messages?.[0]).toEqual({
      role: "system",
      content: [
        { type: "text", text: "cached prefix", cache_control: { type: "ephemeral" } },
        { type: "text", text: "agent listing" },
      ],
    });
  });

  it("drops an empty non-leading system message instead of padding the prompt", () => {
    const out = anthropicToOpenAIRequest(
      {
        model: "m",
        max_tokens: 16,
        system: "be brief",
        messages: [
          { role: "user", content: "hi" },
          { role: "system", content: "" },
        ],
      } as AnthropicMessagesRequest,
      "m",
      undefined,
    );
    expect(out.messages).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
    ]);
  });
});
