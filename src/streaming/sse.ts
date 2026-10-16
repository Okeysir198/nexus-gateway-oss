/** SSE helpers: split a `text/event-stream` byte stream into event objects, and
 *  re-encode event objects back into SSE bytes. Both wires use the same framing
 *  (`event:` / `data:` lines, blank-line terminated), only the payload shapes differ. */

export interface SseEvent {
  event?: string;
  data: string; // a single `data:` payload (may be multiple lines already joined with \n)
}

/** Parse one SSE chunk-stream into a stream of SseEvent. Handles payloads split
 *  across byte boundaries and multi-line `data:` fields. */
export function sseDecoder(): TransformStream<Uint8Array, SseEvent> {
  const decoder = new TextDecoder();
  let buf = "";
  return new TransformStream({
    transform(chunk, controller) {
      buf += decoder.decode(chunk, { stream: true });
      // Events are separated by a blank line. Handle \n\n and \r\n\r\n.
      const parts = buf.split(/\r?\n\r?\n/);
      buf = parts.pop() ?? "";
      for (const part of parts) {
        const ev = parseEventBlock(part);
        if (ev) controller.enqueue(ev);
      }
    },
    flush(controller) {
      buf += decoder.decode();
      if (buf.trim()) {
        const ev = parseEventBlock(buf);
        if (ev) controller.enqueue(ev);
      }
    },
  });
}

function parseEventBlock(block: string): SseEvent | null {
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith(":")) continue; // comment
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
  }
  if (!dataLines.length && !event) return null;
  return { event, data: dataLines.join("\n") };
}

/** Encode one SseEvent to SSE wire bytes. */
export function encodeSse(ev: SseEvent): string {
  let out = "";
  if (ev.event) out += `event: ${ev.event}\n`;
  // Anthropic/OpenAI both accept a single data: line per payload; split internal
  // newlines into multiple data: lines per spec.
  for (const line of ev.data.split("\n")) out += `data: ${line}\n`;
  return out + "\n";
}

/** Encode a stream of SseEvent into a byte stream. */
export function sseEncoder(): TransformStream<SseEvent, Uint8Array> {
  const encoder = new TextEncoder();
  return new TransformStream({
    transform(ev, controller) {
      controller.enqueue(encoder.encode(encodeSse(ev)));
    },
  });
}

/** `[DONE]` sentinel on the OpenAI wire. */
export const OPENAI_DONE = "[DONE]";
