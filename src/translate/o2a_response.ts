import type { ThinkingBlock } from "../thinking_session_do";

/** OpenAI non-streaming `/v1/chat/completions` response → Anthropic `/v1/messages`
 *  response. Assembles content blocks (text, tool_use, thinking), maps the finish
 *  reason, and adapts usage. Returns the Anthropic body + any thinking blocks seen
 *  (for the ThinkingSessionDO to persist in P3). */

interface OpenAIChoice {
  message?: {
    role?: string;
    content?: string | null;
    tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
    reasoning?: string;
    reasoning_content?: string;
  };
  finish_reason?: string;
}

export interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
}

export interface OpenAIResponse {
  id?: string;
  model?: string;
  choices?: OpenAIChoice[];
  usage?: OpenAIUsage;
}

/** OpenAI-wire usage → Anthropic usage, **de-overlapping the cache counters**.
 *
 *  ⚠️ The two wires disagree about what "prompt tokens" means, and the disagreement is
 *  invisible until someone adds the fields up. `prompt_tokens_details.cached_tokens` is a
 *  SUBSET of `prompt_tokens`; Anthropic's `cache_read_input_tokens` is DISJOINT from
 *  `input_tokens`. Copying one to the other unchanged therefore double-counts every cached
 *  token in any consumer that sums input + cache_read + cache_creation — which is exactly
 *  what a cost roll-up does.
 *
 *  Observed on a Qwen model through this gateway: the same prompt sent three times kept
 *  `prompt_tokens` constant while `cached_tokens` varied. Had they been disjoint,
 *  `prompt_tokens` would have fallen on a cache hit.
 *
 *  The cache fields are emitted only when the upstream reported `prompt_tokens_details`
 *  at all: a route that says nothing about caching is UNKNOWN, not zero, and reporting a
 *  confident 0 would read as "caching is broken here". */
export function openaiToAnthropicUsage(usage?: OpenAIUsage): Record<string, number> {
  const prompt = usage?.prompt_tokens ?? 0;
  const details = usage?.prompt_tokens_details;
  const out: Record<string, number> = {
    input_tokens: prompt,
    output_tokens: usage?.completion_tokens ?? 0,
  };
  if (!details) return out;
  const cacheRead = details.cached_tokens ?? 0;
  const cacheWrite = details.cache_write_tokens ?? 0;
  out.input_tokens = Math.max(0, prompt - cacheRead - cacheWrite);
  out.cache_read_input_tokens = cacheRead;
  out.cache_creation_input_tokens = cacheWrite;
  return out;
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

export interface O2AResult {
  body: Record<string, unknown>;
  thinkingBlocks: ThinkingBlock[];
}

export function openaiToAnthropicResponse(resp: OpenAIResponse): O2AResult {
  const choice = resp.choices?.[0];
  const msg = choice?.message;
  const content: AnthropicContentBlock[] = [];
  const thinkingBlocks: ThinkingBlock[] = [];

  const reasoning = msg?.reasoning_content ?? msg?.reasoning;
  if (reasoning) {
    content.push({ type: "thinking", thinking: reasoning });
    thinkingBlocks.push({ type: "thinking", thinking: reasoning });
  }

  if (msg?.content) {
    content.push({ type: "text", text: msg.content });
  }

  for (const tc of msg?.tool_calls ?? []) {
    let input: unknown = {};
    try {
      input = JSON.parse(tc.function?.arguments ?? "{}");
    } catch {
      input = {};
    }
    content.push({
      type: "tool_use",
      id: tc.id ?? "",
      name: tc.function?.name ?? "",
      input,
    });
  }

  const result: O2AResult = {
    body: {
      id: resp.id ?? "msg_nexus",
      type: "message",
      role: "assistant",
      model: resp.model ?? "",
      content: content.length ? content : [{ type: "text", text: "" }],
      stop_reason: mapFinishReason(choice?.finish_reason),
      stop_sequence: null,
      usage: openaiToAnthropicUsage(resp.usage),
    },
    thinkingBlocks,
  };
  return result;
}

export function mapFinishReason(reason?: string): string {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "content_filter":
      return "end_turn"; // Anthropic has no content_filter stop_reason
    default:
      return reason ? "end_turn" : "end_turn";
  }
}
