import type { Env, GatewayConfig, ProviderEntry } from "./types";

/** The provider registry in D1 — the layer that makes "add a provider" a console action
 *  rather than a deploy.
 *
 *  Overlay semantics: the bundled `config.default.json` is the FLOOR, D1 rows win on top.
 *  That ordering is deliberate:
 *    - a fresh deployment with an empty D1 still serves traffic (no chicken-and-egg);
 *    - a D1 outage degrades to the bundled set instead of refusing every model;
 *    - a row can disable a bundled provider (`enabled = 0`) without editing code.
 *
 *  D1 rather than KV, for the same reason auth uses D1: this table gates spend, and KV's
 *  eventual consistency means a provider you just disabled could still be served.
 *
 *  Cached per isolate for 60s — same trade-off as the auth cache. A change from the
 *  console is live within a minute; that is fast enough for adding a provider and slow
 *  enough that we are not reading D1 on every request. */

const TTL_MS = 60_000;
let cache: { providers: Record<string, ProviderEntry>; aliases: Record<string, string>; at: number } | null = null;

interface Row {
  name: string;
  slug: string;
  upstream: string;
  secret: string | null;
  key_pool: string | null;
  path: string | null;
  reasoning: string | null;
  drop_tools: number;
  translate: string | null;
  enabled: number;
  note: string | null;
}

function rowToEntry(r: Row): ProviderEntry {
  const e: ProviderEntry = {
    slug: r.slug,
    upstream: (r.upstream || "openai_chat") as ProviderEntry["upstream"],
    enabled: r.enabled !== 0,
  };
  if (r.secret) e.secret = r.secret;
  if (r.key_pool) e.keyPool = r.key_pool;
  if (r.path) e.path = r.path;
  if (r.reasoning) e.reasoning = r.reasoning as ProviderEntry["reasoning"];
  if (r.drop_tools) e.dropTools = true;
  if (r.translate === "none") e.translate = "none";
  if (r.note) e.note = r.note;
  return e;
}

/** Read the registry. Returns empty maps (never throws) when D1 is unavailable or the
 *  tables don't exist yet — the caller falls back to the bundled config. */
export async function loadRegistry(
  env: Env,
): Promise<{ providers: Record<string, ProviderEntry>; aliases: Record<string, string> }> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return { providers: cache.providers, aliases: cache.aliases };

  const providers: Record<string, ProviderEntry> = {};
  const aliases: Record<string, string> = {};
  try {
    const [pr, al] = await Promise.all([
      env.KEYS_DB.prepare(
        `SELECT name, slug, upstream, secret, key_pool, path, reasoning, drop_tools,
                translate, enabled, note FROM providers`,
      ).all<Row>(),
      env.KEYS_DB.prepare(`SELECT alias, target FROM provider_aliases`).all<{ alias: string; target: string }>(),
    ]);
    for (const r of pr.results ?? []) providers[r.name] = rowToEntry(r);
    for (const a of al.results ?? []) aliases[a.alias] = a.target;
  } catch (e) {
    // Not fatal: the bundled config still serves. Logged so a missing migration is
    // visible rather than silently halving the provider list.
    console.error(`provider registry read failed (falling back to bundled config): ${e}`);
    return { providers: {}, aliases: {} };
  }

  cache = { providers, aliases, at: now };
  return { providers, aliases };
}

/** Drop the isolate cache so a console write is visible immediately in THIS isolate.
 *  Other isolates still wait out the TTL — acceptable for a provider list, and the same
 *  behavior the auth cache has. */
export function invalidateRegistry(): void {
  cache = null;
}

/** Merge the D1 registry over a bundled config. */
export function overlay(
  cfg: GatewayConfig,
  reg: { providers: Record<string, ProviderEntry>; aliases: Record<string, string> },
): GatewayConfig {
  if (!Object.keys(reg.providers).length && !Object.keys(reg.aliases).length) return cfg;
  return {
    ...cfg,
    providers: { ...cfg.providers, ...reg.providers },
    aliases: { ...cfg.aliases, ...reg.aliases },
  };
}

/* ── writes (console) ─────────────────────────────────────────────────────── */

export interface ProviderInput {
  name: string;
  slug: string;
  upstream?: string;
  secret?: string | null;
  keyPool?: string | null;
  path?: string | null;
  reasoning?: string | null;
  dropTools?: boolean;
  translate?: string | null;
  enabled?: boolean;
  note?: string | null;
}

export async function upsertProvider(env: Env, p: ProviderInput): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.KEYS_DB.prepare(
    `INSERT INTO providers
       (name, slug, upstream, secret, key_pool, path, reasoning, drop_tools, translate,
        enabled, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       slug = excluded.slug, upstream = excluded.upstream, secret = excluded.secret,
       key_pool = excluded.key_pool, path = excluded.path, reasoning = excluded.reasoning,
       drop_tools = excluded.drop_tools, translate = excluded.translate,
       enabled = excluded.enabled, note = excluded.note, updated_at = excluded.updated_at`,
  )
    .bind(
      p.name,
      p.slug,
      p.upstream ?? "openai_chat",
      p.secret ?? null,
      p.keyPool ?? null,
      p.path ?? null,
      p.reasoning ?? null,
      p.dropTools ? 1 : 0,
      p.translate ?? null,
      p.enabled === false ? 0 : 1,
      p.note ?? null,
      now,
      now,
    )
    .run();
  invalidateRegistry();
}

export async function deleteProvider(env: Env, name: string): Promise<number> {
  const res = await env.KEYS_DB.prepare(`DELETE FROM providers WHERE name = ?`).bind(name).run();
  invalidateRegistry();
  return res.meta?.changes ?? 0;
}

export async function setAlias(env: Env, alias: string, target: string): Promise<void> {
  await env.KEYS_DB.prepare(
    `INSERT INTO provider_aliases (alias, target, created_at) VALUES (?, ?, ?)
     ON CONFLICT(alias) DO UPDATE SET target = excluded.target`,
  )
    .bind(alias, target, Math.floor(Date.now() / 1000))
    .run();
  invalidateRegistry();
}

export async function deleteAlias(env: Env, alias: string): Promise<number> {
  const res = await env.KEYS_DB.prepare(`DELETE FROM provider_aliases WHERE alias = ?`).bind(alias).run();
  invalidateRegistry();
  return res.meta?.changes ?? 0;
}

/** List for the console: every provider with where it came from, so an operator can see
 *  which are editable (D1) and which are baked into the deploy (bundled). */
export function describeAll(
  cfg: GatewayConfig,
  reg: { providers: Record<string, ProviderEntry>; aliases: Record<string, string> },
  bundledNames: Set<string>,
): Array<ProviderEntry & { name: string; source: "d1" | "bundled" }> {
  return Object.entries(cfg.providers)
    .map(([name, p]) => ({
      ...p,
      name,
      source: (reg.providers[name] ? "d1" : bundledNames.has(name) ? "bundled" : "d1") as "d1" | "bundled",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
