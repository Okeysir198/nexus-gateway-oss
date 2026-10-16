import type { Env } from "./types";
import {
  generateToken,
  hashToken,
  listKeys,
  revokeKey,
  toEpochSeconds,
  upsertKey,
  type KeyRecord,
} from "./keys_db";
import { invalidBody, json, readJsonObject } from "./errors";
import { requireMaster } from "./auth";

/** Key-management endpoints. D1 is the sole authority: keys are minted, revoked and listed
 *  against D1 only. Machine auth is NEXUS_MASTER_KEY (`requireMaster`). */

/** Parse a `duration` ("30d", "24h", "60m", "3600s") into seconds. */
function parseDuration(d: unknown): number | null {
  if (typeof d !== "string") return null;
  const m = /^(\d+)\s*([smhdw])$/.exec(d.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const mult = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[m[2] as "s" | "m" | "h" | "d" | "w"];
  return n * mult;
}

/** GET /key/list — list the D1 keys for the admin console (no secrets). */
export async function keyList(env: Env, request: Request): Promise<Response> {
  const denied = requireMaster(env, request);
  if (denied) return denied;
  return json(200, { keys: await listKeys(env) });
}

/** Mint a key from a request body. Shared by the master-gated `/key/generate` (machines)
 *  and the session-gated `/admin/api/keys` (console) so both paths cannot drift. */
export async function mintKey(
  env: Env,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const now = Math.floor(Date.now() / 1000);
  const durationS = parseDuration(body.duration);
  const expires_at =
    toEpochSeconds(body.expires_at ?? body.expires) ?? (durationS !== null ? now + durationS : null);

  const raw = generateToken();
  const rec: KeyRecord = {
    key_id: `key-${crypto.randomUUID()}`,
    key: raw,
    key_alias: typeof body.key_alias === "string" ? body.key_alias : undefined,
    created_at: now,
    expires_at,
    max_budget: typeof body.max_budget === "number" ? body.max_budget : null,
    rpm_limit: typeof body.rpm_limit === "number" ? body.rpm_limit : null,
    tpm_limit: typeof body.tpm_limit === "number" ? body.tpm_limit : null,
  };

  try {
    await upsertKey(env, await hashToken(raw), rec);
  } catch (e) {
    console.error(`key generate failed: ${e}`);
    return { status: 503, body: { error: { message: "key store unavailable" } } };
  }

  return {
    status: 200,
    body: { key: raw, key_id: rec.key_id!, key_alias: rec.key_alias ?? null, expires: expires_at },
  };
}

/** Revoke by raw token and/or key_id. Returns rows actually revoked. Shared by
 *  `/key/delete` and the console. */
export async function revokeKeys(
  env: Env,
  parsed: { keys?: string[]; key_ids?: string[] },
): Promise<number> {
  let deleted = 0;
  for (const raw of parsed.keys ?? []) deleted += await revokeKey(env, await hashToken(raw));
  for (const id of parsed.key_ids ?? []) deleted += await revokeKey(env, id);
  return deleted;
}

/** POST /key/generate — mint a virtual key into D1 and return it.
 *  The raw token is returned ONCE here and never stored; only its SHA-256 is persisted. */
export async function keyGenerate(env: Env, request: Request): Promise<Response> {
  const denied = requireMaster(env, request);
  if (denied) return denied;
  // An empty body is valid: mint a key with defaults.
  const body = (await readJsonObject(request)) ?? {};
  const res = await mintKey(env, body);
  return json(res.status, res.body);
}

/** POST /key/delete — revoke in D1. Accepts `{keys:[raw...]}` and/or `{key_ids:[...]}`.
 *  Raw tokens are hashed before they reach revokeKey (see its warning). */
export async function keyDelete(env: Env, request: Request): Promise<Response> {
  const denied = requireMaster(env, request);
  if (denied) return denied;

  const parsed = await readJsonObject<{ keys?: unknown; key_ids?: unknown }>(request);
  if (!parsed) return invalidBody();
  const strings = (v: unknown): string[] | null =>
    v === undefined ? [] : Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null;
  const rawKeys = parsed && typeof parsed === "object" ? strings(parsed.keys) : null;
  const keyIds = parsed && typeof parsed === "object" ? strings(parsed.key_ids) : null;
  if (!rawKeys || !keyIds) return json(400, { error: { message: "keys and key_ids must be arrays of strings" } });
  if (rawKeys.length === 0 && keyIds.length === 0) {
    return json(400, { error: { message: "provide keys[] or key_ids[]" } });
  }

  let deleted = 0;
  try {
    deleted = await revokeKeys(env, { keys: rawKeys, key_ids: keyIds });
  } catch (e) {
    console.error(`key delete failed: ${e}`);
    return json(503, { error: { message: "key store unavailable" } });
  }

  // Report the truth: 0 matched is not a successful deletion.
  if (deleted === 0) return json(404, { error: { message: "no matching live key" }, deleted: 0 });
  return json(200, { deleted });
}
