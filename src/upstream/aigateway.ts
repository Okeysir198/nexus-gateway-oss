import type { Env, GatewayConfig, ResolvedRoute } from "../types";
import { DROP_RESPONSE_HEADERS, filterHeaders } from "../headers";
import { pickKey } from "./openai";
import { markCooldown, liveIndices } from "../keypool";
import { upstreamError } from "../errors";

const AIG_BASE = "https://gateway.ai.cloudflare.com/v1";

/** Build a gateway URL. Returns null when AI Gateway isn't configured.
 *
 *  AI Gateway appends everything after `{slug}/` to the provider's configured base_url
 *  VERBATIM. So the slug carries no path of its own and the caller supplies the full
 *  upstream path. */
export function aigUrl(env: Env, slug: string, path: string, search = ""): string | null {
  if (!env.CF_ACCOUNT_ID || !env.AIG_GATEWAY_ID) return null;
  return `${AIG_BASE}/${env.CF_ACCOUNT_ID}/${env.AIG_GATEWAY_ID}/${slug}${path}${search}`;
}

/** Egress one request through Cloudflare AI Gateway. `body` already carries the final
 *  `model`. The provider key goes in `Authorization` per request and AI Gateway relays it,
 *  adding retry, cache, tracing and the dashboard log. SSE streams through unchanged.
 *  There is no retry here: AI Gateway's own retry covers transient 429/5xx, and pooled
 *  routes rotate keys in `callCloudViaAIG`. */
export async function callViaAIGateway(
  env: Env,
  slug: string,
  body: string,
  reqHeaders: Headers,
  providerKey: string,
  timeoutMs: number,
  path = "/v1/chat/completions",
  extraHeaders?: Record<string, string>,
): Promise<Response> {
  const url = aigUrl(env, slug, path);
  if (!url) return upstreamError(503, "AI Gateway not configured (CF_ACCOUNT_ID/AIG_GATEWAY_ID)", "server_error");

  const headers = new Headers();
  headers.set("content-type", "application/json");
  if (providerKey) {
    headers.set("Authorization", `Bearer ${providerKey}`);
    headers.set("x-api-key", providerKey); // Anthropic-native providers want x-api-key
  }
  const accept = reqHeaders.get("accept");
  if (accept) headers.set("accept", accept);
  if (extraHeaders) for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v);

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return upstreamError(502, `AI Gateway egress failed: ${e}`, "server_error");
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: filterHeaders(upstream.headers, DROP_RESPONSE_HEADERS),
  });
}

const json503 = (msg: string): Response => upstreamError(503, msg, "server_error");

/** Egress through AI Gateway with the route's key resolution: single-key routes make one
 *  call; pooled routes (NVIDIA) rotate across keys on a 429/5xx, parking each failed key
 *  in cooldown, which AI Gateway cannot do itself. */
export async function callCloudViaAIG(
  cfg: GatewayConfig,
  route: ResolvedRoute,
  env: Env,
  slug: string,
  body: string,
  reqHeaders: Headers,
  timeoutMs: number,
  /** BYOK: the caller's own provider key. It replaces the single secret and the pooled key;
   *  nothing is rotated or cooled, since the quota being spent is the caller's. */
  byok?: string,
): Promise<Response> {
  const entry = route.entry;
  const path = entry.path ?? "/v1/chat/completions";

  if (byok) return callViaAIGateway(env, slug, body, reqHeaders, byok, timeoutMs, path);

  if (!entry.keyPool) {
    const key = pickKey(cfg, route, env);
    if (!key?.value) return json503(`no API key configured for provider ${route.provider}`);
    return callViaAIGateway(env, slug, body, reqHeaders, key.value, timeoutMs, path);
  }

  const pool = cfg.keyPools[entry.keyPool];
  if (!pool) return json503(`unknown key pool ${entry.keyPool}`);
  const maxAttempts = (cfg.numRetries ?? 4) + 1;
  let last: Response | null = null;
  for (let i = 0; i < maxAttempts; i++) {
    const key = pickKey(cfg, route, env);
    if (!key?.value) return json503(`no live key in pool ${entry.keyPool}`);
    const resp = await callViaAIGateway(env, slug, body, reqHeaders, key.value, timeoutMs, path);
    // 2xx / 4xx (caller error) → return; 429/5xx → cool this key, try the next.
    if (resp.status !== 429 && resp.status < 500) return resp;
    if (key.index !== undefined) markCooldown(entry.keyPool, pool, key.index);
    // Cancel the failed attempt's body: an abandoned Response holds its upstream stream
    // open for the life of the request.
    await last?.body?.cancel().catch(() => {});
    last = resp;
    if (liveIndices(pool, env).length <= 1) return resp; // no other key to rotate to
  }
  return last ?? json503("all pool keys failed");
}
