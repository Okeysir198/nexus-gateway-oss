// Hop-by-hop headers + caller auth + Cloudflare-injected headers that must not be
// forwarded upstream. Each upstream authenticates with its own key.

export const DROP_REQUEST_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "authorization",
  "x-api-key", // Anthropic-style caller auth — re-added per upstream
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "cf-worker",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-real-ip",
]);

export const DROP_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

export function filterHeaders(src: Headers, drop: Set<string>): Headers {
  const out = new Headers();
  for (const [k, v] of src) {
    if (!drop.has(k.toLowerCase())) out.set(k, v);
  }
  return out;
}
