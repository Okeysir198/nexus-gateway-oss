import type { Env, GatewayConfig } from "./types";
import { b64url, b64urlDecode } from "./admin/session";

/** Provider API keys entered in the console (Providers tab) instead of `wrangler secret put`.
 *
 *  A key is stored in D1, AES-GCM encrypted, under the NAME of the secret a provider already
 *  references (`NVIDIA_API_KEY`, `GROQ_API_KEY`, ...). On a chat request the stored keys are
 *  laid over `env` (see `withProviderKeys`), so every existing lookup (`pickKey`, the key
 *  pool, health probes, the Anthropic surface) keeps reading `env[secretName]` and none of
 *  them knows where the value came from.
 *
 *  Rules that keep this from becoming a way to rewrite the Worker's own configuration:
 *  - A Worker secret ALWAYS wins over a stored key, so a deploy that sets one is never
 *    silently overridden from the console.
 *  - Only names that some provider (or key pool) references are ever read or written. The
 *    name list is the gateway's own config, never caller input, so a stored row cannot
 *    shadow NEXUS_MASTER_KEY, ADMIN_SESSION_SECRET or a binding.
 *  - The AES key is derived from KEY_ENCRYPTION_SECRET, or NEXUS_MASTER_KEY when that is
 *    unset. Changing that value makes stored keys undecryptable: they read as missing and
 *    must be entered again. D1 alone (an export, a leaked backup) is not enough to read them.
 *  - Each ciphertext is bound to its secret name (AES-GCM additional data), so a row cannot
 *    be copied under another name. */

const TTL_MS = 60_000;
const MAX_VALUE_LEN = 512;
/** A secret NAME (an env var), never a key value. */
export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

type KeyRecord = Record<string, unknown>;

let cache: { values: Map<string, string>; at: number } | null = null;

/** Forget the cached keys, so a console write is live in this isolate at once. */
export function invalidateProviderKeys(): void {
  cache = null;
}

/** referencedSecrets, memoised per config object (loadConfig hands back the same object
 *  until its cache expires), so the request path does not rebuild the map each time. */
const referenced = new WeakMap<GatewayConfig, Map<string, string[]>>();
function referencedFor(cfg: GatewayConfig): Map<string, string[]> {
  let m = referenced.get(cfg);
  if (!m) referenced.set(cfg, (m = referencedSecrets(cfg)));
  return m;
}

/** Every secret name the config uses, with the providers that use it. */
export function referencedSecrets(cfg: GatewayConfig): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (secret: string | undefined, provider: string) => {
    if (!secret || !SECRET_NAME_RE.test(secret)) return;
    const list = out.get(secret) ?? [];
    if (!list.includes(provider)) list.push(provider);
    out.set(secret, list);
  };
  for (const [name, p] of Object.entries(cfg.providers)) {
    add(p.secret, name);
    if (p.keyPool) for (const s of cfg.keyPools?.[p.keyPool]?.secrets ?? []) add(s, name);
  }
  return out;
}

async function aesKey(env: Env): Promise<CryptoKey | null> {
  const material = env.KEY_ENCRYPTION_SECRET || env.NEXUS_MASTER_KEY;
  if (!material) return null;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`nexus-provider-keys:v1:${material}`),
  );
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptKey(env: Env, secretName: string, value: string): Promise<string> {
  const key = await aesKey(env);
  if (!key) throw new Error("NEXUS_MASTER_KEY (or KEY_ENCRYPTION_SECRET) must be set to store provider keys");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(secretName) },
    key,
    new TextEncoder().encode(value),
  );
  return `v1.${b64url(iv)}.${b64url(new Uint8Array(ct))}`;
}

/** The plaintext, or null when the record is malformed or the encryption secret changed.
 *  Pass `key` (from aesKey) when decrypting many rows, to derive it once. */
export async function decryptKey(
  env: Env,
  secretName: string,
  stored: string,
  derived?: CryptoKey | null,
): Promise<string | null> {
  const key = derived === undefined ? await aesKey(env) : derived;
  const [v, iv, ct] = stored.split(".");
  if (!key || v !== "v1" || !iv || !ct) return null;
  try {
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64urlDecode(iv) as BufferSource, additionalData: new TextEncoder().encode(secretName) },
      key,
      b64urlDecode(ct) as BufferSource,
    );
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

const TABLE_SQL = `CREATE TABLE IF NOT EXISTS provider_keys (
  secret_name TEXT PRIMARY KEY,
  ciphertext  TEXT NOT NULL,
  hint        TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT
)`;

/** Create the table on first write (once per isolate), so an existing deployment whose
 *  schema.sql predates it needs no manual migration. Keep TABLE_SQL in step with schema.sql. */
let tableReady = false;
async function ensureTable(env: Env): Promise<void> {
  if (tableReady) return;
  await env.KEYS_DB.prepare(TABLE_SQL).run();
  tableReady = true;
}

export interface StoredKeyInfo {
  hint: string;
  updated_at: number;
  updated_by: string | null;
}

/** Metadata only (never the key): which names have a stored value. */
export async function listStoredKeys(env: Env): Promise<Map<string, StoredKeyInfo>> {
  const out = new Map<string, StoredKeyInfo>();
  try {
    const r = await env.KEYS_DB.prepare(
      "SELECT secret_name, hint, updated_at, updated_by FROM provider_keys",
    ).all<{ secret_name: string; hint: string; updated_at: number; updated_by: string | null }>();
    for (const row of r.results ?? []) {
      out.set(row.secret_name, { hint: row.hint, updated_at: row.updated_at, updated_by: row.updated_by });
    }
  } catch {
    // No table yet: nothing stored.
  }
  return out;
}

/** Validate and store a key. Returns an error message, or null on success. */
export async function saveProviderKey(
  env: Env,
  cfg: GatewayConfig,
  secretName: string,
  value: string,
  by: string,
): Promise<string | null> {
  if (!SECRET_NAME_RE.test(secretName)) return "secret name must look like MY_PROVIDER_API_KEY (A-Z, 0-9, _)";
  if (!referencedSecrets(cfg).has(secretName)) {
    return `no provider uses ${secretName}: add the provider (with this secret name) first`;
  }
  const v = value.trim();
  if (v.length < 8 || v.length > MAX_VALUE_LEN) return `key must be 8 to ${MAX_VALUE_LEN} characters`;
  if (/\s/.test(v)) return "key must not contain whitespace";
  let ct: string;
  try {
    ct = await encryptKey(env, secretName, v);
  } catch (e) {
    return e instanceof Error ? e.message : "could not encrypt the key";
  }
  await ensureTable(env);
  await env.KEYS_DB.prepare(
    `INSERT INTO provider_keys (secret_name, ciphertext, hint, updated_at, updated_by)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(secret_name) DO UPDATE SET ciphertext = ?2, hint = ?3, updated_at = ?4, updated_by = ?5`,
  )
    .bind(secretName, ct, v.slice(-4), Math.floor(Date.now() / 1000), by)
    .run();
  invalidateProviderKeys();
  return null;
}

/** Remove a stored key; returns the number of rows deleted. */
export async function deleteProviderKey(env: Env, secretName: string): Promise<number> {
  await ensureTable(env);
  const r = await env.KEYS_DB.prepare("DELETE FROM provider_keys WHERE secret_name = ?1").bind(secretName).run();
  invalidateProviderKeys();
  return r.meta?.changes ?? 0;
}

/** Every stored key, decrypted. Which names may be used is decided later, per request, by
 *  withProviderKeys, so this cache stays valid when the provider list changes. */
async function loadValues(env: Env): Promise<Map<string, string>> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.values;
  const values = new Map<string, string>();
  let failed = false;
  try {
    const r = await env.KEYS_DB.prepare("SELECT secret_name, ciphertext FROM provider_keys").all<{
      secret_name: string;
      ciphertext: string;
    }>();
    const key = await aesKey(env);
    const rows = r.results ?? [];
    const plain = await Promise.all(rows.map((row) => decryptKey(env, row.secret_name, row.ciphertext, key)));
    rows.forEach((row, i) => {
      const value = plain[i];
      if (value) values.set(row.secret_name, value);
      else console.error(`stored key ${row.secret_name} could not be decrypted (encryption secret changed?)`);
    });
  } catch {
    // No table, or D1 unavailable: Worker secrets still serve. Remember the failure for only
    // a few seconds, so a blip does not hide stored keys for a full TTL.
    failed = true;
  }
  cache = { values, at: failed ? now - TTL_MS + 5_000 : now };
  return values;
}

/** `env` with stored provider keys laid over it. The result inherits every binding and
 *  secret from `env` (prototype chain); only the stored names are own properties, and only
 *  where the Worker has no secret of that name. */
export async function withProviderKeys(env: Env, cfg: GatewayConfig): Promise<Env> {
  const values = await loadValues(env);
  if (!values.size) return env;
  const allowed = referencedFor(cfg);
  const over: KeyRecord = Object.create(env as unknown as object) as KeyRecord;
  const raw = env as unknown as KeyRecord;
  for (const [name, value] of values) {
    if (allowed.has(name) && !raw[name]) over[name] = value;
  }
  return over as unknown as Env;
}
