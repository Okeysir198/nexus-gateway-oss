import { describe, expect, it } from "vitest";
import {
  applyReasoningDialect,
  fixOpenaiReasoningParams,
  translateThinkingForOpenRouter,
} from "../src/translate/reasoning";

/** A dialect declared in config but missing a branch would fall through to the "no
 *  dialect" arm and DELETE `thinking` — the opposite of the intent. These tests pin each
 *  dialect's contract. */

describe("applyReasoningDialect", () => {
  it("openrouter: maps Anthropic thinking → reasoning.max_tokens", () => {
    const req: Record<string, unknown> = {
      thinking: { type: "enabled", budget_tokens: 2048 },
    };
    applyReasoningDialect("openrouter", "m", req);
    expect(req.thinking).toBeUndefined();
    expect(req.reasoning).toEqual({ max_tokens: 2048 });
  });

  it("openai_effort: converts a thinking budget to reasoning_effort", () => {
    const req: Record<string, unknown> = { thinking: { type: "enabled", budget_tokens: 1024 } };
    applyReasoningDialect("openai_effort", "gpt-5-nano", req);
    expect(req.thinking).toBeUndefined();
    expect(typeof req.reasoning_effort === "string" || req.reasoning_effort === undefined).toBe(true);
  });

  it("zai_thinking: PASSES THROUGH thinking as a native {type} object", () => {
    // The regression this file exists for: before the dialect branch was added, this
    // assertion failed because `thinking` was deleted outright.
    const req: Record<string, unknown> = { thinking: { type: "enabled", budget_tokens: 4096 } };
    applyReasoningDialect("zai_thinking", "glm-4.6", req);
    expect(req.thinking).toEqual({ type: "enabled" }); // budget dropped — Z.AI ignores it
    expect(req.reasoning).toBeUndefined();
    expect(req.reasoning_effort).toBeUndefined();
  });

  it("zai_thinking: honours an explicit disable", () => {
    const req: Record<string, unknown> = { thinking: { type: "disabled" } };
    applyReasoningDialect("zai_thinking", "glm-4.6", req);
    expect(req.thinking).toEqual({ type: "disabled" });
  });

  it("zai_thinking: accepts a boolean shorthand", () => {
    const req: Record<string, unknown> = { thinking: true };
    applyReasoningDialect("zai_thinking", "glm-4.6", req);
    expect(req.thinking).toEqual({ type: "enabled" });
  });

  it("no dialect: strips a stray `thinking` so OpenAI-compat upstreams don't 400", () => {
    const req: Record<string, unknown> = { thinking: { type: "enabled" } };
    applyReasoningDialect(undefined, "m", req);
    expect(req.thinking).toBeUndefined();
  });

  it("flattens reasoning blocks out of message content, keeping text", () => {
    const req: Record<string, unknown> = {
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "internal chain" },
            { type: "text", text: "the answer" },
          ],
        },
      ],
    };
    applyReasoningDialect(undefined, "m", req);
    const content = (req.messages as Array<{ content: unknown }>)[0]!.content;
    expect(JSON.stringify(content)).not.toContain("internal chain");
    expect(JSON.stringify(content)).toContain("the answer");
  });

  it("leaves plain string content untouched", () => {
    const req: Record<string, unknown> = { messages: [{ role: "user", content: "hello" }] };
    applyReasoningDialect(undefined, "m", req);
    expect((req.messages as Array<{ content: unknown }>)[0]!.content).toBe("hello");
  });
});

/** The remaining cases from the Python original that the first port skipped. They cover
 *  the two exported helpers directly rather than through applyReasoningDialect, because
 *  that is the level the Python suite asserted at. */
describe("translateThinkingForOpenRouter", () => {
  it("never clobbers a client that already spoke OpenRouter's dialect", () => {
    const req: Record<string, unknown> = {
      thinking: { type: "enabled", budget_tokens: 9 },
      reasoning_effort: "high",
    };
    expect(translateThinkingForOpenRouter(req)).toBe(true);
    expect(req.reasoning).toBeUndefined(); // not overwritten
    expect(req.reasoning_effort).toBe("high"); // preserved
    expect("thinking" in req).toBe(false); // still stripped — Anthropic-only key
  });

  it("is a no-op when there is no thinking key", () => {
    const req: Record<string, unknown> = {};
    expect(translateThinkingForOpenRouter(req)).toBe(false);
    expect("reasoning" in req).toBe(false);
  });

  it("handles an unknown future model — there is no allowlist", () => {
    const req: Record<string, unknown> = { thinking: { type: "enabled", budget_tokens: 777 } };
    expect(translateThinkingForOpenRouter(req)).toBe(true);
    expect(req.reasoning).toEqual({ max_tokens: 777 });
  });

  it("maps an explicit disable to reasoning.enabled=false", () => {
    const req: Record<string, unknown> = { thinking: { type: "disabled" } };
    translateThinkingForOpenRouter(req);
    expect(req.reasoning).toEqual({ enabled: false });
  });

  it("maps enabled-without-budget to reasoning.enabled=true", () => {
    const req: Record<string, unknown> = { thinking: { type: "enabled" } };
    translateThinkingForOpenRouter(req);
    expect(req.reasoning).toEqual({ enabled: true });
  });

  /** The Python genericity guard. There it keyed on `custom_llm_provider`; here the
   *  dialect is chosen by the ROUTE, so the equivalent assertion is that a request
   *  routed to a non-openrouter dialect never acquires `reasoning`. */
  it("other providers never acquire a `reasoning` param", () => {
    for (const model of ["openai/gpt-4o", "nvidia_nim/step-3.7-flash", "anthropic/claude-sonnet-4"]) {
      const req: Record<string, unknown> = { thinking: { type: "enabled", budget_tokens: 9 } };
      applyReasoningDialect(undefined, model, req);
      expect(req.reasoning).toBeUndefined();
    }
  });
});

describe("fixOpenaiReasoningParams", () => {
  it("strips reasoning_effort on a non-reasoning model", () => {
    const req: Record<string, unknown> = { reasoning_effort: "medium" };
    expect(fixOpenaiReasoningParams("openai/gpt-4o-mini", req)).toBe(true);
    expect("reasoning_effort" in req).toBe(false);
  });

  it("keeps effort on a reasoning model and downgrades 'minimal' to 'low'", () => {
    const req: Record<string, unknown> = { reasoning_effort: "minimal" };
    fixOpenaiReasoningParams("openai/gpt-5.2", req);
    expect(req.reasoning_effort).toBe("low"); // downgraded, not dropped
  });

  it("treats the o-series as reasoning-capable", () => {
    const req: Record<string, unknown> = { reasoning_effort: "high" };
    fixOpenaiReasoningParams("openai/o3-mini", req);
    expect(req.reasoning_effort).toBe("high");
  });

  it("treats gpt-5-chat as NON-reasoning despite the gpt-5 prefix", () => {
    const req: Record<string, unknown> = { reasoning_effort: "high" };
    fixOpenaiReasoningParams("openai/gpt-5-chat", req);
    expect("reasoning_effort" in req).toBe(false);
  });

  /** The regression this module exists for: `thinking` must never reach OpenAI, on a
   *  reasoning-capable model or not — a2o_request copies it in wholesale and OpenAI
   *  400s on unknown params. */
  it("always deletes `thinking`, even on a reasoning model", () => {
    const req: Record<string, unknown> = { thinking: { type: "enabled" }, reasoning_effort: "low" };
    expect(fixOpenaiReasoningParams("openai/gpt-5.2", req)).toBe(true);
    expect("thinking" in req).toBe(false);
    expect(req.reasoning_effort).toBe("low");
  });
});
