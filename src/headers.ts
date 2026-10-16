// Hop-by-hop headers, caller credentials and Cloudflare-injected headers that must not be
// forwarded upstream. Each egress sets its own upstream credential.

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
  "cookie", // a browser client's cookies are never the upstream's business
  "x-api-key", // the caller's key; the egress sets the upstream's
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
