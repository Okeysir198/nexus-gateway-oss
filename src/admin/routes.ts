import type { Env } from "../types";
import { invalidBody, json, readJsonObject } from "../errors";
import { adminLogout, requireAdmin } from "./login";
import { csrfOk } from "./session";
import { mintKey, revokeKeys } from "../key_webhook";
import { listKeys } from "../keys_db";
import { AigError, ensureCustomProvider, validateBaseUrl } from "../aig_providers";
import { bundledProviderNames, invalidateConfig, loadConfig } from "../config";
import { SECRET_NAME_RE, deleteProviderKey, listStoredKeys, referencedSecrets, saveProviderKey } from "../provider_keys";
import {
  deleteAlias,
  deleteProvider,
  describeAll,
  loadRegistry,
  setAlias,
  upsertProvider,
  type ProviderInput,
} from "../providers_db";

/** /admin/api/* — the console's server side.
 *
 *  Auth is the operator SESSION (signed HttpOnly cookie from the sign-in page), not the
 *  master key, so the gateway's most privileged credential never reaches the browser.
 *
 *  These routes mint credentials and steer live routing, so the session gate is
 *  load-bearing — there is no second check further down. */


/** decodeURIComponent that answers null instead of throwing on a malformed escape. */
function decodeSegment(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/** Handle an /admin/* API request. Returns null if the path isn't ours. */
export async function adminApi(env: Env, request: Request, path: string): Promise<Response | null> {
  // Unauthenticated endpoint: signing out. (Signing in is handled in index.ts, before
  // this gate.)
  if (path === "/admin/logout" && request.method === "POST") return adminLogout();

  if (path !== "/admin/whoami" && !path.startsWith("/admin/api/")) return null;

  const id = await requireAdmin(env, request);
  if (!id.ok) return json(401, { error: { message: id.reason ?? "not signed in" } });
  if (!csrfOk(request)) return json(403, { error: { message: "missing console header" } });

  if (path === "/admin/whoami") {
    return json(200, { email: id.email });
  }

  // ── Keys ──────────────────────────────────────────────────────────────────────
  // Session-gated twins of /key/*. The master-key endpoints stay as they are: they are
  // the machine surface AND the recovery path if the console ever locks you out.
  if (path === "/admin/api/keys" && request.method === "GET") {
    return json(200, { keys: await listKeys(env) });
  }
  if (path === "/admin/api/keys" && request.method === "POST") {
    const body = (await readJsonObject(request)) ?? {};
    const res = await mintKey(env, body);
    console.warn(`[admin] key minted by ${id.email} alias=${String(body.key_alias ?? "-")}`);
    return json(res.status, res.body);
  }
  if (path === "/admin/api/keys/revoke" && request.method === "POST") {
    const body = await readJsonObject<{ key_ids?: string[] }>(request);
    if (!body) return invalidBody();
    if (!body.key_ids?.length) return json(400, { error: { message: "key_ids[] required" } });
    const deleted = await revokeKeys(env, { key_ids: body.key_ids });
    console.warn(`[admin] ${deleted} key(s) revoked by ${id.email}`);
    if (deleted === 0) return json(404, { error: { message: "no matching live key" }, deleted: 0 });
    return json(200, { deleted });
  }

  // ── Providers ─────────────────────────────────────────────────────────────────
  // Editing this registry is how a provider gets added WITHOUT a deploy. Rows overlay
  // the bundled config; `source` tells the operator which is which.
  if (path === "/admin/api/providers" && request.method === "GET") {
    const cfg = await loadConfig(env);
    const reg = await loadRegistry(env);
    return json(200, {
      providers: describeAll(cfg, reg, bundledProviderNames()),
      aliases: cfg.aliases ?? {},
      catchAll: cfg.catchAll ?? null,
      canRegister: Boolean(env.AIG_API_TOKEN),
    });
  }

  // Provider API keys. The VALUE never comes back out: the list carries the secret's name,
  // who uses it, where it comes from and the last four characters.
  if (path === "/admin/api/provider-keys" && request.method === "GET") {
    const cfg = await loadConfig(env);
    const stored = await listStoredKeys(env);
    const raw = env as unknown as Record<string, unknown>;
    const keys = [...referencedSecrets(cfg)].map(([secret, providers]) => {
      const s = stored.get(secret);
      const fromWorker = Boolean(raw[secret]);
      return {
        secret,
        providers,
        source: fromWorker ? "worker" : s ? "console" : "missing",
        hint: fromWorker ? null : (s?.hint ?? null),
        updated_at: s?.updated_at ?? null,
      };
    });
    return json(200, { keys });
  }

  if (path === "/admin/api/provider-keys" && request.method === "POST") {
    const body = await readJsonObject<{ secret?: unknown; value?: unknown }>(request);
    if (!body) return invalidBody();
    if (typeof body.secret !== "string" || typeof body.value !== "string") {
      return json(400, { error: { message: "secret and value are required" } });
    }
    const err = await saveProviderKey(env, await loadConfig(env), body.secret, body.value, String(id.email ?? ""));
    if (err) return json(400, { error: { message: err } });
    console.warn(`[admin] provider key ${body.secret} stored by ${id.email}`);
    return json(200, { ok: true });
  }

  const km = path.match(/^\/admin\/api\/provider-keys\/([^/]+)$/);
  if (km && request.method === "DELETE") {
    const secret = decodeSegment(km[1]!);
    if (secret === null || !SECRET_NAME_RE.test(secret)) return json(400, { error: { message: "invalid secret name" } });
    const n = await deleteProviderKey(env, secret);
    console.warn(`[admin] provider key ${secret} removed by ${id.email} (rows=${n})`);
    return json(200, { deleted: n });
  }

  if (path === "/admin/api/providers" && request.method === "POST") {
    const body = await readJsonObject<ProviderInput & { baseUrl?: unknown }>(request);
    if (!body) return invalidBody();
    if (!body.name || !body.slug) return json(400, { error: { message: "name and slug are required" } });
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(body.name)) {
      return json(400, { error: { message: "invalid provider name" } });
    }
    // A slug that is neither native nor `custom-`-prefixed will 404 at AI Gateway with a
    // confusing message, so reject it here where we can explain.
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(body.slug)) {
      return json(400, { error: { message: "invalid AI Gateway slug" } });
    }
    // The secret is the NAME of an env var / stored key, never the key itself.
    if (body.secret != null && (typeof body.secret !== "string" || !SECRET_NAME_RE.test(body.secret))) {
      return json(400, { error: { message: "secret must be an env var name like MY_PROVIDER_API_KEY" } });
    }
    // With a base URL the gateway registers the custom provider in AI Gateway first, so a
    // bad URL or a refused token fails before anything is saved.
    let registered: "registered" | "exists" | undefined;
    if (body.baseUrl != null && body.baseUrl !== "") {
      if (!/^custom-/i.test(body.slug)) {
        return json(400, { error: { message: "a provider registered from a base URL needs a slug starting with custom-" } });
      }
      if (!env.AIG_API_TOKEN) {
        return json(400, { error: { message: "set the AIG_API_TOKEN secret to register providers from the console, or register it in AI Gateway by hand" } });
      }
      try {
        const baseUrl = validateBaseUrl(body.baseUrl, new URL(request.url).hostname);
        registered = await ensureCustomProvider(env, body.slug, baseUrl);
      } catch (e) {
        if (!(e instanceof AigError)) throw e;
        return json(400, { error: { message: e.message } });
      }
    }
    await upsertProvider(env, body);
    invalidateConfig();
    console.warn(`[admin] provider ${body.name} → ${body.slug} saved by ${id.email}${registered ? ` (${registered} in AI Gateway)` : ""}`);
    return json(200, { ok: true, name: body.name, registered });
  }

  const pm = path.match(/^\/admin\/api\/providers\/([^/]+)$/);
  if (pm && request.method === "DELETE") {
    const name = decodeSegment(pm[1]!);
    if (name === null) return json(400, { error: { message: "invalid provider name" } });
    const n = await deleteProvider(env, name);
    invalidateConfig();
    console.warn(`[admin] provider ${name} deleted by ${id.email} (rows=${n})`);
    // 0 rows means it is a BUNDLED provider — deletable only by editing the config and
    // deploying. Say so rather than reporting a success that changed nothing.
    if (n === 0) {
      return json(409, {
        error: { message: `${name} is bundled with the deploy — disable it instead, or edit src/config.default.json` },
      });
    }
    return json(200, { deleted: n });
  }

  if (path === "/admin/api/providers/alias" && request.method === "POST") {
    const b = await readJsonObject<{ alias?: string; target?: string }>(request);
    if (!b) return invalidBody();
    if (!b.alias || !b.target) return json(400, { error: { message: "alias and target are required" } });
    await setAlias(env, b.alias, b.target);
    invalidateConfig();
    return json(200, { ok: true });
  }

  const am = path.match(/^\/admin\/api\/providers\/alias\/([^/]+)$/);
  if (am && request.method === "DELETE") {
    const alias = decodeSegment(am[1]!);
    if (alias === null) return json(400, { error: { message: "invalid alias" } });
    const n = await deleteAlias(env, alias);
    invalidateConfig();
    return json(n ? 200 : 404, n ? { deleted: n } : { error: { message: "not a D1 alias" } });
  }

  return json(404, { error: { message: "unknown admin api route", path } });
}
