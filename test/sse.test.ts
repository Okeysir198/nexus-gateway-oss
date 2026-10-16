import { describe, expect, it } from "vitest";
import { sseDecoder, encodeSse, type SseEvent } from "../src/streaming/sse";

/** `src/streaming/sse.ts` makes two explicit claims in its header comment — that it
 *  handles events split across chunk boundaries, and multi-line `data:`. Neither had a
 *  test. Both are exactly the kind of thing that works until a provider changes its
 *  flush granularity and then corrupts every streamed response. */

async function collect(chunks: string[]): Promise<SseEvent[]> {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const s of chunks) c.enqueue(enc.encode(s));
      c.close();
    },
  });
  const out: SseEvent[] = [];
  const reader = stream.pipeThrough(sseDecoder()).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

/** Split a string into raw BYTE chunks at a given index — not char chunks. */
function byteChunks(s: string, at: number): string[] {
  return [s.slice(0, at), s.slice(at)];
}

describe("sseDecoder", () => {
  it("parses a simple event", async () => {
    const ev = await collect(['data: {"a":1}\n\n']);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.data).toBe('{"a":1}');
  });

  it("reassembles an event split MID-JSON across two chunks", async () => {
    const ev = await collect(byteChunks('data: {"hello":"wo', 0).concat(['rld"}\n\n']));
    expect(ev).toHaveLength(1);
    expect(JSON.parse(ev[0]!.data!)).toEqual({ hello: "world" });
  });

  it("reassembles when the split lands inside the terminator", async () => {
    const ev = await collect(['data: {"a":1}\n', "\n", 'data: {"b":2}\n\n']);
    expect(ev.map((e) => e.data)).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("does not mojibake a multi-byte UTF-8 char split across chunks", async () => {
    // "é" is 2 bytes; slicing the encoded form mid-character is the real-world case.
    const full = 'data: {"t":"café ☕"}\n\n';
    const bytes = new TextEncoder().encode(full);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, 18));
        c.enqueue(bytes.slice(18));
        c.close();
      },
    });
    const reader = stream.pipeThrough(sseDecoder()).getReader();
    const { value } = await reader.read();
    expect(JSON.parse(value!.data!).t).toBe("café ☕");
  });

  it("joins multi-line data with a newline", async () => {
    const ev = await collect(["data: line1\ndata: line2\n\n"]);
    expect(ev[0]!.data).toBe("line1\nline2");
  });

  it("handles CRLF terminators", async () => {
    const ev = await collect(['data: {"a":1}\r\n\r\n']);
    expect(ev[0]!.data).toBe('{"a":1}');
  });

  it("strips exactly ONE leading space after the colon", async () => {
    // Per spec. A "tidier" strip-all-whitespace would corrupt indented payloads.
    const ev = await collect(["data:  two-spaces\n\n"]);
    expect(ev[0]!.data).toBe(" two-spaces");
  });

  it("skips comment lines", async () => {
    const ev = await collect([": keep-alive\n\n", "data: real\n\n"]);
    expect(ev.map((e) => e.data)).toEqual(["real"]);
  });

  it("carries the event name", async () => {
    const ev = await collect(["event: content_block_delta\ndata: {}\n\n"]);
    expect(ev[0]!.event).toBe("content_block_delta");
  });

  it("round-trips through encodeSse", async () => {
    const original: SseEvent = { event: "message_delta", data: "line1\nline2" };
    const ev = await collect([encodeSse(original)]);
    expect(ev[0]!.event).toBe(original.event);
    expect(ev[0]!.data).toBe(original.data);
  });
});
