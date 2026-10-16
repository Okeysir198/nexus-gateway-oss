import type { Env, VirtualKey } from "./types";

/** Mint a new virtual key. `sk-` prefix is deliberate: callers and log scrapers commonly
 *  recognise that format. 32 bytes of CSPRNG (256 bits) base64url-encoded. */
export function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const b64 = btoa(String.fromCharCode(...bytes));
  return "sk-" + b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Coerce a timestamp to epoch SECONDS. Load-bearing: SQLite accepts an ISO string in an
 *  INTEGER column, and a string breaks `lookupKey`'s `expires_at < now` check (expiry would
 *  silently never fire) and `listKeys`' ORDER BY. Accepts a number (epoch s or ms), an ISO
 *  string, or null. */
export function toEpochSeconds(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number" && Number.isFinite(v)) {
    // Heuristic: anything past ~year 33658 is milliseconds, not seconds.
    return v > 1e11 ? Math.floor(v / 1000) : Math.floor(v);
  }
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n) && v.trim() !== "") return n > 1e11 ? Math.floor(n / 1000) : Math.floor(n);
    const parsed = Date.parse(v);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return null;
}

/** SHA-256 hex of a raw token — the lookup key. Only the hash is ever stored, so a D1
 *  dump cannot be replayed as a live token. */
export async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Look up a live virtual key by token hash. Returns null if absent / revoked / expired. */
export async function lookupKey(env: Env, tokenHash: string): Promise<VirtualKey | null> {
  const row = await env.KEYS_DB.prepare(
    `SELECT key_id, token_hash, token_prefix, key_alias, created_at, expires_at,
            revoked_at, max_budget, rpm_limit, tpm_limit
     FROM virtual_keys
     WHERE token_hash = ? AND revoked_at IS NULL`,
  )
    .bind(tokenHash)
    .first<VirtualKey>();
  if (!row) return null;
  const now = Math.floor(Date.now() / 1000);
  if (row.expires_at !== null && row.expires_at < now) return null;
  return row;
}

export interface KeyRecord {
  key_id?: string;
  key?: string; // the raw token; used for the prefix, NEVER stored
  key_alias?: string;
  max_budget?: number | null;
  rpm_limit?: number | null;
  tpm_limit?: number | null;
  // Timestamps may arrive as ISO strings; everything goes through toEpochSeconds().
  expires_at?: number | string | null;
  created_at?: number | string;
}

/** Insert or update a key (idempotent on key_id). */
export async function upsertKey(env: Env, tokenHash: string, rec: KeyRecord): Promise<void> {
  const raw = rec.key;
  if (!raw) return;
  const now = Math.floor(Date.now() / 1000);
  // NEVER persist the raw token: `raw_json` is spillover for fields without a column, and a
  // token there would make "a D1 dump never leaks live keys" false.
  const { key: _k, ...safeRec } = rec;
  await env.KEYS_DB.prepare(
    `INSERT INTO virtual_keys
       (key_id, token_hash, token_prefix, key_alias, created_at, expires_at,
        revoked_at, max_budget, rpm_limit, tpm_limit, raw_json)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
     ON CONFLICT(key_id) DO UPDATE SET
       token_hash = excluded.token_hash,
       token_prefix = excluded.token_prefix,
       key_alias = excluded.key_alias,
       expires_at = excluded.expires_at,
       max_budget = excluded.max_budget,
       rpm_limit = excluded.rpm_limit,
       tpm_limit = excluded.tpm_limit,
       raw_json = excluded.raw_json,
       revoked_at = NULL`,
  )
    .bind(
      rec.key_id ?? tokenHash,
      tokenHash,
      raw.slice(0, 12),
      rec.key_alias ?? null,
      toEpochSeconds(rec.created_at) ?? now,
      toEpochSeconds(rec.expires_at),
      rec.max_budget ?? null,
      rec.rpm_limit ?? null,
      rec.tpm_limit ?? null,
      JSON.stringify(safeRec),
    )
    .run();
}

/** Mark a key revoked by key_id or token HASH. Returns rows affected.
 *
 *  ⚠️ Never pass a raw `sk-...` token here — it matches neither column (token_hash holds
 *  the SHA-256), so the UPDATE silently affects 0 rows and the key stays live. Hash first:
 *  `revokeKey(env, await hashToken(raw))`. The return value exists so callers can tell
 *  "revoked" from "matched nothing" instead of always reporting success. */
export async function revokeKey(env: Env, keyIdOrHash: string): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const res = await env.KEYS_DB.prepare(
    `UPDATE virtual_keys SET revoked_at = ?
     WHERE (key_id = ? OR token_hash = ?) AND revoked_at IS NULL`,
  )
    .bind(now, keyIdOrHash, keyIdOrHash)
    .run();
  return res.meta?.changes ?? 0;
}

/** List all keys for the admin console — newest first, no secrets (token_hash/raw_json
 *  omitted; only the non-reversible prefix is returned). */
export async function listKeys(env: Env): Promise<Array<Record<string, unknown>>> {
  const res = await env.KEYS_DB.prepare(
    `SELECT key_id, key_alias, token_prefix, created_at, expires_at, revoked_at,
            max_budget, rpm_limit, tpm_limit
     FROM virtual_keys
     ORDER BY created_at DESC`,
  ).all();
  return (res.results ?? []) as Array<Record<string, unknown>>;
}
