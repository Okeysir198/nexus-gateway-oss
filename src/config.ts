import type { Env, GatewayConfig } from "./types";
// Two layers. The bundled file (imported at build time) is the FLOOR — it travels with
// the code, so a fresh deploy always has a working registry and there is no
// chicken-and-egg on first boot. The D1 `providers` table overlays it at runtime, which
// is what makes adding a provider a console action instead of a deploy.
// NOT KV, deliberately: this gates spend, and KV's eventual consistency means a provider
// you just disabled could still be served.
import bundled from "../config.default.json";
import { loadRegistry, overlay } from "./providers_db";

const TTL_MS = 30_000;
let cache: { cfg: GatewayConfig; at: number } | null = null;

const UPSTREAMS = new Set(["openai_chat", "anthropic_native"]);
const DIALECTS = new Set(["openrouter", "openai_effort", "zai_thinking"]);

/** Read a secret whose NAME came from config (a provider's `secret`, a key-pool member).
 *
 *  The double assertion is unavoidable — `Env` is a fixed interface and these names are
 *  data. One helper, so a future move to a Secrets Store binding is one edit. */
export function envSecret(env: Env, name: string): string {
  return String((env as unknown as Record<string, unknown>)[name] ?? "");
}

/** Config drift found at load time. Surfaced on /health so a bad value is visible without
 *  trawling logs — a wrong enum value would otherwise produce no signal anywhere. */
let warnings: string[] = [];
export function configWarnings(): string[] {
  return warnings;
}

/** Validate the merged config.
 *
 *  WARN-AND-DROP, never throw on a field-level problem. This runs on the request path of
 *  a Worker serving a production custom domain: a hard throw on a typo would take 100%
 *  of traffic down, which is a far worse failure than one route with a dropped field.
 *  Structural failures (no providers{}) still throw — there is no serving the
 *  request without them. */
function validateConfig(cfg: GatewayConfig): GatewayConfig {
  const w: string[] = [];
  if (!cfg.providers || typeof cfg.providers !== "object") {
    throw new Error("config is malformed — needs providers{}");
  }

  for (const [name, p] of Object.entries(cfg.providers)) {
    if (name.startsWith("_")) continue; // `_comment` keys
    const at = `provider ${name}`;
    // The Worker's core invariant — mirrored by the guard in dispatch().
    if (!p.slug) w.push(`${at}: no slug — would bypass AI Gateway`);
    if (p.upstream && !UPSTREAMS.has(p.upstream)) w.push(`${at}: unknown upstream "${p.upstream}"`);
    if (p.reasoning !== undefined && !DIALECTS.has(p.reasoning)) {
      w.push(`${at}: unknown reasoning dialect "${p.reasoning}" — field ignored`);
      delete (p as { reasoning?: unknown }).reasoning;
    }
    if (p.keyPool && !cfg.keyPools?.[p.keyPool]) {
      w.push(`${at}: references undefined keyPool "${p.keyPool}"`);
    }
  }

  // A dangling alias or catchAll is silent misrouting, so surface both.
  for (const [from, to] of Object.entries(cfg.aliases ?? {})) {
    if (from.startsWith("_")) continue;
    if (!cfg.providers[to]) w.push(`alias ${from} → "${to}" which is not a provider`);
  }
  if (cfg.catchAll && !cfg.providers[cfg.catchAll]) {
    w.push(`catchAll "${cfg.catchAll}" is not a provider — unknown models will 404`);
  }

  warnings = w;
  for (const msg of w) console.error(`[config] ${msg}`);
  return cfg;
}

/** Strip `_comment` keys and apply `defaults` to every provider, so the rest of the code
 *  reads a fully-resolved entry and the config file can stay near-empty per provider. */
function applyDefaults(cfg: GatewayConfig): GatewayConfig {
  const d = (cfg as unknown as { defaults?: Partial<GatewayConfig["providers"][string]> }).defaults ?? {};
  const out: GatewayConfig["providers"] = {};
  for (const [name, p] of Object.entries(cfg.providers ?? {})) {
    if (name.startsWith("_") || !p || typeof p !== "object") continue;
    out[name] = { upstream: "openai_chat", ...d, ...p };
  }
  cfg.providers = out;
  const al: Record<string, string> = {};
  for (const [k, v] of Object.entries(cfg.aliases ?? {})) if (!k.startsWith("_")) al[k] = v;
  cfg.aliases = al;
  return cfg;
}

/** The provider names that ship in the bundle — used by the console to show which
 *  entries are editable (D1) versus baked into the deploy. */
export function bundledProviderNames(): Set<string> {
  const raw = (bundled as unknown as { providers?: Record<string, unknown> }).providers ?? {};
  return new Set(Object.keys(raw).filter((k) => !k.startsWith("_")));
}

/** Load gateway config: the bundled registry with ${VAR} interpolated, then the D1
 *  registry overlaid on top.
 *
 *  Bundled is the FLOOR and D1 wins — so a fresh deployment with an empty database still
 *  serves traffic, a D1 outage degrades to the bundled set rather than refusing every
 *  model, and a row can disable a bundled provider without a code change. */
export async function loadConfig(env: Env): Promise<GatewayConfig> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.cfg;
  const base = applyDefaults(
    interpolate(bundled as unknown as GatewayConfig, env as unknown as Record<string, unknown>),
  );
  const reg = await loadRegistry(env);
  const merged = overlay(base, reg);
  // Defaults again: a D1 row carries only what the operator set, so `upstream` and the
  // default path must be filled in for rows the first pass never saw.
  const cfg = validateConfig(applyDefaults(merged));
  cache = { cfg, at: now };
  return cfg;
}

/** Drop the config cache — called after a console write so the change is live in this
 *  isolate immediately instead of after the TTL. */
export function invalidateConfig(): void {
  cache = null;
}

/** Recursively expand ${VAR} references using the Env secrets. */
export function interpolate<T>(value: T, env: Record<string, unknown>): T {
  if (typeof value === "string") {
    return value.replace(/\$\{(\w+)\}/g, (_, k) => String(env[k] ?? "")) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => interpolate(v, env)) as unknown as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        interpolate(v, env),
      ]),
    ) as unknown as T;
  }
  return value;
}
