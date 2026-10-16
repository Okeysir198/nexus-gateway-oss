import type { Env } from "./types";
import { hashToken, lookupKey } from "./keys_db";
import { json } from "./errors";

export interface AuthResult {
  ok: boolean;
  reason?: string;
  alias?: string;
  /** The presented token when it was NOT a D1 virtual key: the BYOK candidate. Set only on
   *  the failure path; the chat and Anthropic-surface branches in index.ts may forward it
   *  upstream as the caller's own provider key. */
  byokToken?: string;
}

const encoder = new TextEncoder();

/** Compare two byte arrays without an early exit on the first differing byte. */
export function safeEqualBytes(x: Uint8Array, y: Uint8Array): boolean {
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function safeEqual(a: string, b: string): boolean {
  return safeEqualBytes(encoder.encode(a), encoder.encode(b));
}

/** The machine-endpoint gate: NEXUS_MASTER_KEY or nothing. Returns a Response to send, or
 *  null to proceed. Fail-CLOSED: if the secret is unset we 503 rather than open up. */
export function requireMaster(env: Env, request: Request): Response | null {
  if (!env.NEXUS_MASTER_KEY) {
    return json(503, { error: { message: "NEXUS_MASTER_KEY not set" } });
  }
  if (!safeEqual(extractToken(request) ?? "", env.NEXUS_MASTER_KEY)) {
    return json(401, { error: { message: "admin key required" } });
  }
  return null;
}

/** Extract the bearer / x-api-key token from a request. */
export function extractToken(request: Request): string | null {
  const auth = request.headers.get("Authorization");
  // Scheme names are case-insensitive (RFC 7235); `Token <key>` is accepted for SDKs that
  // send it.
  const lower = auth?.toLowerCase() ?? "";
  if (lower.startsWith("bearer ")) return (auth as string).slice(7).trim();
  if (lower.startsWith("token ")) return (auth as string).slice(6).trim();
  const xapikey = request.headers.get("x-api-key");
  if (xapikey) return xapikey.trim();
  const url = new URL(request.url);
  const q = url.searchParams.get("api_key");
  if (q) return q;
  return null;
}

// Per-isolate key cache: positive 60s, negative 10s, so a revocation can take up to 60s to
// reach a warm isolate. D1, not KV, is the store: KV's eventual consistency disqualifies it.
const POS_TTL = 60_000;
const NEG_TTL = 10_000;
// Bounded, because the negative path lets an unauthenticated caller choose the keys: a token
// spray would otherwise grow the map without limit. Clearing wholesale is fine; the worst
// case is one round of D1 lookups to repopulate.
const CACHE_MAX = 1000;
const cache = new Map<string, { ok: boolean; alias?: string; at: number }>();

function cacheSet(token: string, entry: { ok: boolean; alias?: string; at: number }): void {
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(token, entry);
}

/** Authenticate a caller: master-key fast-path, then D1 (cached). A token not in D1 is not
 *  a virtual key; it may still be a BYOK candidate (see `byokToken`). */
export async function authenticate(env: Env, request: Request): Promise<AuthResult> {
  const master = env.NEXUS_MASTER_KEY;
  // Fail CLOSED, matching requireMaster: an unset secret must never authenticate everyone.
  if (!master) return { ok: false, reason: "gateway not configured" };

  const token = extractToken(request);
  if (!token) return { ok: false, reason: "missing API key" };
  if (safeEqual(token, master)) return { ok: true, alias: "master" };

  const cached = cache.get(token);
  const now = Date.now();
  if (cached) {
    if (cached.ok && now - cached.at < POS_TTL) return { ok: true, alias: cached.alias };
    if (!cached.ok && now - cached.at < NEG_TTL) return { ok: false, reason: "invalid API key", byokToken: token };
  }

  let row;
  try {
    row = await lookupKey(env, await hashToken(token));
  } catch (e) {
    // A D1 outage is NOT "invalid key": fail closed but do not cache the verdict, or a
    // blip would stretch into 10s of 401s per isolate.
    console.error(`D1 key lookup failed: ${e}`);
    return { ok: false, reason: "key store unavailable" };
  }

  if (row) {
    const alias = row.key_alias ?? "virtual";
    cacheSet(token, { ok: true, alias, at: now });
    return { ok: true, alias };
  }
  cacheSet(token, { ok: false, at: now });
  return { ok: false, reason: "invalid API key", byokToken: token };
}
