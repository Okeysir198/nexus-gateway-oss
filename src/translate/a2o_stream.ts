import type { SseEvent } from "../streaming/sse";
import { sseDecoder, sseEncoder, OPENAI_DONE } from "../streaming/sse";
import type { ThinkingBlock } from "../thinking_session_do";
import type { OpenAIUsage } from "./o2a_response";
import { mapFinishReason, openaiToAnthropicUsage } from "./o2a_response";

/** Convert an OpenAI `/v1/chat/completions` SSE byte stream into an Anthropic
 *  `/v1/messages` SSE byte stream. Implements the Anthropic event protocol:
 *    message_start → (content_block_start / content_block_delta / content_block_stop)*
 *    → message_delta → message_stop
 *
 *  Two classic translation bugs are handled by construction:
 *    • FIRST TEXT CHUNK — the delta that triggers content_block_start is NEVER
 *      consumed as a control signal; content_block_start carries text:"" and the
 *      delta is immediately emitted as a content_block_delta.
 *    • PARALLEL TOOL CALLS — a single OpenAI chunk carrying N delta.tool_calls
 *      entries opens N separate tool_use blocks (one per OpenAI tool_call index);
 *      argument fragments route to the right block by index.
 *
 *  `onDone` is fired from flush() with any merged reasoning blocks, for the
 *  ThinkingSessionDO to persist. Call from a `ctx.waitUntil` inside onDone. */

interface OpenAIToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAIChunkDelta {
  content?: string;
  reasoning?: string;
  reasoning_content?: string;
  tool_calls?: OpenAIToolCallDelta[];
}

interface OpenAIChunk {
  id?: string;
  model?: string;
  choices?: Array<{ delta?: OpenAIChunkDelta; finish_reason?: string | null }>;
  usage?: OpenAIUsage;
}

export function anthropicSseFromOpenAIStream(
  upstream: ReadableStream<Uint8Array>,
  model: string,
  onDone?: (thinking: ThinkingBlock[]) => void,
): ReadableStream<Uint8Array> {
  const thinkingRaw: ThinkingBlock[] = [];

  const sm = openAIToAnthropicStateMachine(model, thinkingRaw, () => {
    // merge consecutive reasoning fragments into a single thinking block
    const merged = thinkingRaw.reduce((acc, b) => {
      const last = acc[acc.length - 1];
      if (last && last.type === "thinking" && b.type === "thinking") {
        last.thinking = (last.thinking ?? "") + (b.thinking ?? "");
      } else {
        acc.push({ ...b });
      }
      return acc;
    }, [] as ThinkingBlock[]);
    onDone?.(merged);
  });

  return upstream.pipeThrough(sseDecoder()).pipeThrough(sm).pipeThrough(sseEncoder());
}

function openAIToAnthropicStateMachine(
  model: string,
  thinkingRaw: ThinkingBlock[],
  onFlush: () => void,
): TransformStream<SseEvent, SseEvent> {
  let started = false;
  let nextIndex = 0;
  let messageId = "msg_nexus";
  let outputTokens = 0;
  let finalUsage: OpenAIUsage | undefined;
  // ⚠️ The OpenAI usage chunk arrives AFTER the chunk carrying `finish_reason`, so emitting
  // the terminal `message_delta` the moment a finish_reason lands throws the usage away —
  // `finish()` is once-only, and the counters turn up one chunk too late. The reason is
  // therefore REMEMBERED and the delta is emitted at `[DONE]`/flush, which is where the
  // stream actually ends. Even with `stream_options.include_usage` set and the mapping
  // correct, a streamed translated turn would still report 0 tokens purely because of this
  // ordering.
  let pendingReason: string | null = null;
  let finishSent = false;

  let textBlockIndex: number | null = null;
  let thinkingBlockIndex: number | null = null;
  const toolBlockByOpenaiIndex = new Map<number, number>();
  const openBlocks = new Set<number>();

  const emit = (event: string, data: unknown): SseEvent => ({ event, data: JSON.stringify(data) });

  function startMessage(chunk: OpenAIChunk): SseEvent {
    if (chunk.id) messageId = chunk.id;
    return emit("message_start", {
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { ...openaiToAnthropicUsage(chunk.usage), output_tokens: 0 },
      },
    });
  }

  function stopBlock(idx: number, controller: TransformStreamDefaultController<SseEvent>): void {
    if (!openBlocks.delete(idx)) return;
    controller.enqueue(emit("content_block_stop", { type: "content_block_stop", index: idx }));
  }

  function finish(reason: string, controller: TransformStreamDefaultController<SseEvent>): void {
    if (finishSent) return;
    finishSent = true;
    for (const idx of [...openBlocks].sort((a, b) => a - b)) stopBlock(idx, controller);
    textBlockIndex = null;
    thinkingBlockIndex = null;
    toolBlockByOpenaiIndex.clear();
    const delta: Record<string, unknown> = { stop_reason: reason, stop_sequence: null };
    controller.enqueue(
      emit("message_delta", {
        type: "message_delta",
        delta,
        // Input-side counters ride the final delta for the same reason: they do not
        // exist yet at message_start.
        ...(outputTokens || finalUsage
          ? {
              usage: {
                ...(finalUsage ? openaiToAnthropicUsage(finalUsage) : {}),
                output_tokens: outputTokens,
              },
            }
          : {}),
      }),
    );
    controller.enqueue(emit("message_stop", { type: "message_stop" }));
  }

  return new TransformStream({
    transform(ev, controller) {
      const data = ev.data?.trim();
      if (!data) return;

      if (data === OPENAI_DONE) {
        if (!started) controller.enqueue(startMessage({}));
        started = true;
        finish(pendingReason ?? "end_turn", controller);
        return;
      }

      let chunk: OpenAIChunk;
      try {
        chunk = JSON.parse(data);
      } catch {
        return;
      }

      if (!started) {
        controller.enqueue(startMessage(chunk));
        started = true;
      }
      if (chunk.usage?.completion_tokens) outputTokens = chunk.usage.completion_tokens;
      // ⚠️ On the OpenAI wire the usage block arrives with the LAST chunk (or not at all
      // without `stream_options.include_usage`), never the first — so `message_start`'s
      // copy is structurally zero and the cache counters would be lost entirely if this
      // did not keep them for `message_delta`.
      if (chunk.usage?.prompt_tokens || chunk.usage?.prompt_tokens_details) {
        finalUsage = chunk.usage;
      }

      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      if (!delta) return;

      // reasoning → one thinking block (opened lazily, stopped when text/tools begin)
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (reasoning) {
        if (thinkingBlockIndex === null) {
          thinkingBlockIndex = nextIndex++;
          openBlocks.add(thinkingBlockIndex);
          controller.enqueue(
            emit("content_block_start", {
              type: "content_block_start",
              index: thinkingBlockIndex,
              content_block: { type: "thinking", thinking: "" },
            }),
          );
        }
        thinkingRaw.push({ type: "thinking", thinking: reasoning });
        controller.enqueue(
          emit("content_block_delta", {
            type: "content_block_delta",
            index: thinkingBlockIndex,
            delta: { type: "thinking_delta", thinking: reasoning },
          }),
        );
      }

      // text → text block. FIRST-CHUNK FIX: start with text:"" then emit the delta.
      if (delta.content) {
        if (thinkingBlockIndex !== null) {
          stopBlock(thinkingBlockIndex, controller);
          thinkingBlockIndex = null;
        }
        if (textBlockIndex === null) {
          textBlockIndex = nextIndex++;
          openBlocks.add(textBlockIndex);
          controller.enqueue(
            emit("content_block_start", {
              type: "content_block_start",
              index: textBlockIndex,
              content_block: { type: "text", text: "" },
            }),
          );
        }
        controller.enqueue(
          emit("content_block_delta", {
            type: "content_block_delta",
            index: textBlockIndex,
            delta: { type: "text_delta", text: delta.content },
          }),
        );
      }

      // tool_calls → one tool_use block per OpenAI index (PARALLEL-TOOL SPLIT)
      for (const tc of delta.tool_calls ?? []) {
        const oi = tc.index ?? 0;
        let blockIdx = toolBlockByOpenaiIndex.get(oi);
        if (blockIdx === undefined) {
          blockIdx = nextIndex++;
          toolBlockByOpenaiIndex.set(oi, blockIdx);
          openBlocks.add(blockIdx);
          controller.enqueue(
            emit("content_block_start", {
              type: "content_block_start",
              index: blockIdx,
              content_block: { type: "tool_use", id: tc.id ?? "", name: tc.function?.name ?? "", input: {} },
            }),
          );
        }
        const frag = tc.function?.arguments;
        if (frag) {
          controller.enqueue(
            emit("content_block_delta", {
              type: "content_block_delta",
              index: blockIdx,
              delta: { type: "input_json_delta", partial_json: frag },
            }),
          );
        }
      }

      if (choice?.finish_reason) {
        pendingReason = mapFinishReason(choice.finish_reason);
      }
    },
    flush(controller) {
      // A provider that ends the stream without `[DONE]` must still get a terminal delta.
      if (started) finish(pendingReason ?? "end_turn", controller);
      onFlush();
    },
  });
}
