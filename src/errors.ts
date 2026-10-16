import type { Wire } from "./types";

/** Build a JSON error Response in the requested wire's envelope. */
export function errorResponse(status: number, message: string, wire: Wire, type = "invalid_request_error"): Response {
  const body =
    wire === "anthropic"
      ? {
          type: "error",
          error: { type, message },
        }
      : {
          error: { message, type, code: status },
        };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** An upstream/infrastructure failure in the OpenAI envelope.
 *
 *  Use this instead of hand-writing `JSON.stringify({error: …})`: a bare
 *  `{error: "some string"}` breaks any OpenAI SDK client, since those read
 *  `error.message` and get `undefined`. One helper, one shape. */
export function upstreamError(status: number, message: string, type = "server_error"): Response {
  return json(status, { error: { message, type, code: status } });
}
