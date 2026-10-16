import type { Env } from "./types";
import { hashToken, lookupKey } from "./keys_db";
import { json } from "./errors";

export interface AuthResult {
  ok: boolean;
  reason?: string;
  alias?: string;
  /** The presented token when it was NOT a D1 virtual key — the BYOK candidate.
   *  Set only on the failure path, and meaningful only to the CHAT branch in index.ts,
   *  which may forward it upstream as the caller's own provider key. Anything that is not a
   *  chat path must keep treating `ok: false` as 401: those use the operator's own
   *  credentials, and a stranger's provider key is no claim on them. */
  byokToken?: string;
}

/** The single admin gate: NEXUS_MASTER_KEY or nothing. Returns a Response to send, or
 *  null to proceed. Fail-CLOSED — if the secret is unset we 503 rather than opening up,
 *  because these routes mint keys and stop production services. */
export function requireMaster(env: Env, request: Request): Response | null {
  if (!env.NEXUS_MASTER_KEY) {
    return json(503, { error: { message: "NEXUS_MASTER_KEY not set" } });
  }
  if (extractToken(request) !== env.NEXUS_MASTER_KEY) {
    return json(401, { error: { message: "admin key required" } });
  }
  return null;
}

/** Extract the bearer / x-api-key token from a request. */
export function extractToken(request: Request): string | null {
  const auth = request.headers.get("Authorization");
  // ⚠️ Case-insensitive per RFC 7235: a client sending `bearer` would otherwise get
  // a bare 401 that reads as a wrong key rather than a wrong scheme.
  const lower = auth?.toLowerCase() ?? "";
  if (lower.startsWith("bearer ")) return (auth as string).slice(7).trim();
  // ⚠️ `Token <key>` is accepted too, for clients whose SDK sends that scheme.
  if (lower.startsWith("token ")) return (auth as string).slice(6).trim();
  const xapikey = request.headers.get("x-api-key");
  if (xapikey) return xapikey.trim();
  const url = new URL(request.url);
  const q = url.searchParams.get("api_key");
  if (q) return q;
  return null;
}

// per-isolate key cache: positive 60s, negative 10s. Revocation has up to a 60s
// staleness window. KV is NOT used for auth
// (eventual consistency disqualifies it); D1 is strongly consistent.
const POS_TTL = 60_000;
const NEG_TTL = 10_000;
// Bounded: entries expire logically but were never evicted, and the NEGATIVE path means
// an unauthenticated caller chooses the keys. A token spray could therefore grow this
// map without limit inside a long-lived isolate. Clearing wholesale (rather than LRU) is
// fine here — worst case is one round of D1 lookups to repopulate.
const CACHE_MAX = 1000;
const cache = new Map<string, { ok: boolean; alias?: string; at: number }>();

function cacheSet(token: string, entry: { ok: boolean; alias?: string; at: number }): void {
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(token, entry);
}

/** Authenticate a caller: master-key fast-path → D1 (cached).
 *
 *  D1 is the sole authority: a token not in D1 is not a virtual key (it may still be a
 *  BYOK candidate on the chat paths — see `byokToken`). */
export async function authenticate(env: Env, request: Request): Promise<AuthResult> {
  const master = env.NEXUS_MASTER_KEY;
  // Fail CLOSED, matching requireMaster above. Returning ok:true for local-dev convenience would let an unset secret
  // in production authenticate *everyone*. Put a value in .dev.vars instead.
  if (!master) return { ok: false, reason: "gateway not configured" };

  const token = extractToken(request);
  if (!token) return { ok: false, reason: "missing API key" };
  if (token === master) return { ok: true, alias: "master" };

  const cached = cache.get(token);
  const now = Date.now();
  if (cached) {
    if (cached.ok && now - cached.at < POS_TTL) return { ok: true, alias: cached.alias };
    if (!cached.ok && now - cached.at < NEG_TTL) return { ok: false, reason: "invalid API key", byokToken: token };
  }

  // D1 lookup — the only authority.
  let row;
  try {
    row = await lookupKey(env, await hashToken(token));
  } catch (e) {
    // A D1 outage is NOT "invalid key". Fail closed but do not cache the verdict:
    // negative-caching a transient infra fault would extend a blip into 10s of 401s
    // per isolate, and would let a caller pin a bad verdict for their own token.
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
