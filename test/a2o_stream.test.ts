import { describe, expect, it } from "vitest";
import { anthropicSseFromOpenAIStream } from "../src/translate/a2o_stream";
import { sseDecoder, type SseEvent } from "../src/streaming/sse";

/** `src/translate/a2o_stream.ts` exists to embody two translation-bug fixes (see its header):
 *    1. the first text chunk is EMITTED, not swallowed;
 *    2. one OpenAI chunk carrying N tool_calls opens N Anthropic tool_use blocks.
 *  Neither had a regression test. These are the highest-consequence assertions in the
 *  repo: a regression in either silently truncates or drops user-visible output. */

function openaiStream(chunks: unknown[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(`data: ${JSON.stringify(ch)}\n\n`));
      c.enqueue(enc.encode("data: [DONE]\n\n"));
      c.close();
    },
  });
}

async function anthropicEvents(chunks: unknown[]): Promise<SseEvent[]> {
  const out = anthropicSseFromOpenAIStream(openaiStream(chunks), "test-model");
  const reader = out.pipeThrough(sseDecoder()).getReader();
  const events: SseEvent[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    events.push(value);
  }
  return events;
}

const parse = (e: SseEvent) => JSON.parse(e.data ?? "{}");

describe("a2o_stream — first-text-chunk fix", () => {
  it("emits the very first text delta (nothing swallowed)", async () => {
    const events = await anthropicEvents([
      { choices: [{ delta: { role: "assistant", content: "Hello" } }] },
      { choices: [{ delta: { content: " world" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);
    const text = events
      .filter((e) => e.event === "content_block_delta")
      .map((e) => parse(e).delta?.text ?? "")
      .join("");
    // The classic bug dropped "Hello"; a regression shows up as " world".
    expect(text).toBe("Hello world");
  });

  it("opens the text block with an empty string, not the first token", async () => {
    const events = await anthropicEvents([
      { choices: [{ delta: { content: "Hello" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);
    const start = events.find((e) => e.event === "content_block_start");
    expect(parse(start!).content_block).toMatchObject({ type: "text", text: "" });
  });

  it("emits a well-formed envelope", async () => {
    const events = await anthropicEvents([
      { choices: [{ delta: { content: "hi" } }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]);
    const names = events.map((e) => e.event);
    expect(names[0]).toBe("message_start");
    expect(names).toContain("content_block_stop");
    expect(names).toContain("message_delta");
    expect(names[names.length - 1]).toBe("message_stop");
  });
});

describe("a2o_stream — parallel tool-call split", () => {
  it("opens N blocks for ONE chunk carrying N tool_calls", async () => {
    const events = await anthropicEvents([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call_a", function: { name: "get_weather", arguments: "" } },
                { index: 1, id: "call_b", function: { name: "get_time", arguments: "" } },
              ],
            },
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]);
    const starts = events
      .filter((e) => e.event === "content_block_start")
      .map((e) => parse(e).content_block)
      .filter((b) => b.type === "tool_use");
    // The classic bug collapsed these into one block, losing a tool call entirely.
    expect(starts).toHaveLength(2);
    expect(starts.map((b) => b.name)).toEqual(["get_weather", "get_time"]);
    expect(new Set(starts.map((b) => b.id)).size).toBe(2);
  });

  it("routes later argument fragments to the right block by index", async () => {
    const events = await anthropicEvents([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "a", function: { name: "f0", arguments: "" } },
                { index: 1, id: "b", function: { name: "f1", arguments: "" } },
              ],
            },
          },
        ],
      },
      { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '{"x":1}' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"y":2}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]);
    const byBlock = new Map<number, string>();
    for (const e of events.filter((x) => x.event === "content_block_delta")) {
      const d = parse(e);
      if (d.delta?.type === "input_json_delta") {
        byBlock.set(d.index, (byBlock.get(d.index) ?? "") + d.delta.partial_json);
      }
    }
    const args = [...byBlock.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
    expect(args).toEqual(['{"y":2}', '{"x":1}']);
  });

  it("closes every open block on finish", async () => {
    const events = await anthropicEvents([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "a", function: { name: "f0", arguments: "" } },
                { index: 1, id: "b", function: { name: "f1", arguments: "" } },
              ],
            },
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]);
    const opened = events.filter((e) => e.event === "content_block_start").length;
    const closed = events.filter((e) => e.event === "content_block_stop").length;
    expect(closed).toBe(opened);
  });
});

describe("a2o_stream — edges", () => {
  it("still produces a valid envelope for an empty stream", async () => {
    const events = await anthropicEvents([]);
    expect(events[0]?.event).toBe("message_start");
    expect(events[events.length - 1]?.event).toBe("message_stop");
  });

  it("maps finish_reason to an Anthropic stop_reason", async () => {
    const events = await anthropicEvents([
      { choices: [{ delta: { content: "x" } }] },
      { choices: [{ delta: {}, finish_reason: "length" }] },
    ]);
    const delta = events.find((e) => e.event === "message_delta");
    expect(parse(delta!).delta.stop_reason).toBe("max_tokens");
  });
});
