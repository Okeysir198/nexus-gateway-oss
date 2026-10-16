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
import { json } from "./errors";
import { requireMaster } from "./auth";

/** Key-management endpoints. D1 is the SOLE authority: the Worker mints, revokes and
 *  lists entirely against D1.
 *
 *  Admin auth is NEXUS_MASTER_KEY (`requireMaster`). The response shapes follow the
 *  common `/key/generate` convention (`key`, `key_id`, `key_alias`, `expires`, `duration`). */

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

  // The console and operator scripts parse these fields.
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
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    /* an empty body is valid — mint a key with defaults */
  }
  const res = await mintKey(env, body);
  return json(res.status, res.body);
}

/** POST /key/delete — revoke in D1. Accepts `{keys:[raw...]}` and/or `{key_ids:[...]}`.
 *
 *  The raw tokens MUST be hashed before hitting revokeKey — passing them through
 *  verbatim matches neither `key_id` nor `token_hash`, so the UPDATE would affect 0 rows
 *  while the key stayed live. */
export async function keyDelete(env: Env, request: Request): Promise<Response> {
  const denied = requireMaster(env, request);
  if (denied) return denied;

  let parsed: { keys?: string[]; key_ids?: string[] } = {};
  try {
    parsed = (await request.json()) as { keys?: string[]; key_ids?: string[] };
  } catch {
    return json(400, { error: { message: "invalid JSON body" } });
  }

  const rawKeys = parsed.keys ?? [];
  const keyIds = parsed.key_ids ?? [];
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
