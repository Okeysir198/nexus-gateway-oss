import type { Env } from "../types";
import { json } from "../errors";
import { adminLogout, requireAdmin } from "./login";
import { mintKey, revokeKeys } from "../key_webhook";
import { listKeys } from "../keys_db";
import { bundledProviderNames, invalidateConfig, loadConfig } from "../config";
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
 *  Auth is the operator SESSION (Google sign-in → signed HttpOnly cookie), not the
 *  master key. The console used to hold the master key in sessionStorage and send it on
 *  every call, which meant the gateway's most privileged credential lived in the browser
 *  and was one XSS away from exfiltration. It no longer touches the browser at all.
 *
 *  These routes mint credentials and steer live routing, so the session gate is
 *  load-bearing — there is no second check further down. Operators are NOT created
 *  here any more: the allowlist is the OPERATOR_EMAILS var, edited in wrangler.toml and
 *  applied by a deploy; this file only reads it for the Operators tab. */

/** CSRF: SameSite=Strict already stops the browser attaching our cookie to cross-site
 *  requests. This header is defence in depth — a cross-origin caller cannot set a custom
 *  header without a CORS preflight, which we never answer. Simple requests (forms,
 *  img/script tags) therefore cannot reach a state-changing route. */
function csrfOk(request: Request): boolean {
  if (request.method === "GET" || request.method === "HEAD") return true;
  return request.headers.get("x-nexus-console") === "1";
}

/** The operator allowlist, as the console shows it: trimmed, non-empty entries.
 *  (Enforcement lives in isOperator() at login time — this is the read-only view.) */
export function operatorEmails(env: Env): string[] {
  return (env.OPERATOR_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
}

/** Handle an /admin/* API request. Returns null if the path isn't ours. */
export async function adminApi(env: Env, request: Request, path: string): Promise<Response | null> {
  // Unauthenticated endpoint: signing out. (Signing in is GET /login/google →
  // GET /oauth/google/callback, handled in index.ts before this gate.)
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
    let body: Record<string, unknown> = {};
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      /* defaults are fine */
    }
    const res = await mintKey(env, body);
    console.warn(`[admin] key minted by ${id.email} alias=${String(body.key_alias ?? "-")}`);
    return json(res.status, res.body);
  }
  if (path === "/admin/api/keys/revoke" && request.method === "POST") {
    let body: { key_ids?: string[] } = {};
    try {
      body = (await request.json()) as { key_ids?: string[] };
    } catch {
      return json(400, { error: { message: "invalid JSON body" } });
    }
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
    });
  }

  if (path === "/admin/api/providers" && request.method === "POST") {
    let body: ProviderInput;
    try {
      body = (await request.json()) as ProviderInput;
    } catch {
      return json(400, { error: { message: "invalid JSON body" } });
    }
    if (!body.name || !body.slug) return json(400, { error: { message: "name and slug are required" } });
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(body.name)) {
      return json(400, { error: { message: "invalid provider name" } });
    }
    // A slug that is neither native nor `custom-`-prefixed will 404 at AI Gateway with a
    // confusing message, so reject it here where we can explain.
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(body.slug)) {
      return json(400, { error: { message: "invalid AI Gateway slug" } });
    }
    await upsertProvider(env, body);
    invalidateConfig();
    console.warn(`[admin] provider ${body.name} → ${body.slug} saved by ${id.email}`);
    return json(200, { ok: true, name: body.name });
  }

  const pm = path.match(/^\/admin\/api\/providers\/([^/]+)$/);
  if (pm && request.method === "DELETE") {
    const name = decodeURIComponent(pm[1]!);
    const n = await deleteProvider(env, name);
    invalidateConfig();
    console.warn(`[admin] provider ${name} deleted by ${id.email} (rows=${n})`);
    // 0 rows means it is a BUNDLED provider — deletable only by editing the config and
    // deploying. Say so rather than reporting a success that changed nothing.
    if (n === 0) {
      return json(409, {
        error: { message: `${name} is bundled with the deploy — disable it instead, or edit config.default.json` },
      });
    }
    return json(200, { deleted: n });
  }

  if (path === "/admin/api/providers/alias" && request.method === "POST") {
    let b: { alias?: string; target?: string };
    try {
      b = (await request.json()) as { alias?: string; target?: string };
    } catch {
      return json(400, { error: { message: "invalid JSON body" } });
    }
    if (!b.alias || !b.target) return json(400, { error: { message: "alias and target are required" } });
    await setAlias(env, b.alias, b.target);
    invalidateConfig();
    return json(200, { ok: true });
  }

  const am = path.match(/^\/admin\/api\/providers\/alias\/([^/]+)$/);
  if (am && request.method === "DELETE") {
    const n = await deleteAlias(env, decodeURIComponent(am[1]!));
    invalidateConfig();
    return json(n ? 200 : 404, n ? { deleted: n } : { error: { message: "not a D1 alias" } });
  }

  // ── Operators (read-only) ─────────────────────────────────────────────────────
  // The allowlist is the OPERATOR_EMAILS var, so there is nothing to mutate over the
  // API: adding an operator is a wrangler.toml edit + deploy. The tab shows who may in
  // and who is signed in — the only operator fact the Worker still owns.
  if (path === "/admin/api/users" && request.method === "GET") {
    return json(200, { operators: operatorEmails(env), session: id.email });
  }

  return json(404, { error: { message: "unknown admin api route", path } });
}
