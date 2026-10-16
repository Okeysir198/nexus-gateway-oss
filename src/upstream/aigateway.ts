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

/** Egress one chat request through Cloudflare AI Gateway. The Worker has already
 *  set the `model` field in `body` (stripped, or kept-prefixed for dynamic routes).
 *  The provider key goes in `Authorization` (BYOK per-request); AI Gateway relays
 *  it to the upstream and adds retry + cache + tracing + the dashboard log.
 *
 *  Streaming: AI Gateway passes SSE through unchanged, so we relay the body stream.
 *  No retry here for single-key routes — AI Gateway's gateway-level retry handles
 *  transient 429/5xx. Pooled routes (NVIDIA) retry across keys at the caller. */
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
  if (!env.CF_ACCOUNT_ID || !env.AIG_GATEWAY_ID) {
    return upstreamError(503, "AI Gateway not configured (CF_ACCOUNT_ID/AIG_GATEWAY_ID)", "server_error");
  }
  const url = `${AIG_BASE}/${env.CF_ACCOUNT_ID}/${env.AIG_GATEWAY_ID}/${slug}${path}`;

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

function json503(msg: string): Response {
  return upstreamError(503, msg, "server_error");
}

/** Egress through AI Gateway with the route's key resolution: single-key routes
 *  make one call (AI Gateway's gateway-level retry handles transient 429/5xx);
 *  pooled routes (NVIDIA) rotate across keys on a 429, parking each in cooldown —
 *  preserving the 6-key rotation semantics that AI Gateway can't do itself. */
export async function callCloudViaAIG(
  cfg: GatewayConfig,
  route: ResolvedRoute,
  env: Env,
  slug: string,
  body: string,
  reqHeaders: Headers,
  timeoutMs: number,
  /** BYOK: the caller's own provider key. When present it REPLACES both the single-secret
   *  and the pooled key — there is nothing to rotate, since the quota being spent is the
   *  caller's, and parking their key in our cooldown map would penalise the next caller. */
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
    // Drop the previous failed attempt's body before overwriting it. An abandoned
    // Response keeps its upstream stream open for the life of the request, so without
    // this a fully-rotating pooled call leaks one connection per retry.
    await last?.body?.cancel().catch(() => {});
    last = resp;
    if (liveIndices(pool, env).length <= 1) return resp; // no other key to rotate to
  }
  return last ?? json503("all pool keys failed");
}
