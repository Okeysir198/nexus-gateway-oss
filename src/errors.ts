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

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** The request body as a JSON object, or null when it is missing, malformed, or not an
 *  object (an array, a string, `null`). Callers that accept an empty body use `?? {}`. */
export async function readJsonObject<T extends object = Record<string, unknown>>(request: Request): Promise<T | null> {
  try {
    const parsed: unknown = await request.json();
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as T) : null;
  } catch {
    return null;
  }
}

const INVALID_BODY = { error: { message: "invalid JSON body" } };
/** The 400 every JSON-taking route answers when readJsonObject gave null. */
export const invalidBody = (): Response => json(400, INVALID_BODY);

/** An upstream/infrastructure failure in the OpenAI envelope.
 *
 *  Use this instead of hand-writing `JSON.stringify({error: …})`: a bare
 *  `{error: "some string"}` breaks any OpenAI SDK client, since those read
 *  `error.message` and get `undefined`. One helper, one shape. */
export function upstreamError(status: number, message: string, type = "server_error"): Response {
  return json(status, { error: { message, type, code: status } });
}
