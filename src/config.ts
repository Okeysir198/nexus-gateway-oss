import type { Env, GatewayConfig } from "./types";
import bundled from "./config.default.json";
import { loadRegistry, overlay } from "./providers_db";

const TTL_MS = 30_000;
let cache: { cfg: GatewayConfig; at: number } | null = null;

const UPSTREAMS = new Set(["openai_chat", "anthropic_native"]);
const DIALECTS = new Set(["openrouter", "openai_effort", "zai_thinking"]);

/** Read a secret whose NAME came from config (a provider's `secret`, a key-pool member).
 *  `Env` is a fixed interface and these names are data, hence the cast. */
export function envSecret(env: Env, name: string): string {
  return String((env as unknown as Record<string, unknown>)[name] ?? "");
}

/** Config drift found at load time. Surfaced on /health so a bad value is visible without
 *  trawling logs — a wrong enum value would otherwise produce no signal anywhere. */
let warnings: string[] = [];
export function configWarnings(): string[] {
  return warnings;
}

/** Validate the merged config. WARN-AND-DROP: a field-level problem is reported on /health
 *  and never thrown, because this runs on the request path and a typo must not take all
 *  traffic down. Only a missing `providers` map throws. */
function validateConfig(cfg: GatewayConfig): GatewayConfig {
  const w: string[] = [];
  if (!cfg.providers || typeof cfg.providers !== "object") {
    throw new Error("config is malformed — needs providers{}");
  }

  for (const [name, p] of Object.entries(cfg.providers)) {
    if (name.startsWith("_")) continue; // `_comment` keys
    const at = `provider ${name}`;
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

/** Load gateway config: the bundled registry (the FLOOR, shipped with the code) with the D1
 *  registry overlaid on top (D1 wins). A fresh deployment with an empty database still
 *  serves, a D1 outage degrades to the bundled set, and a row can disable a bundled
 *  provider without a deploy. Not KV: this gates spend, and KV's eventual consistency
 *  could keep serving a provider you just disabled. */
export async function loadConfig(env: Env): Promise<GatewayConfig> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.cfg;
  const base = applyDefaults(structuredClone(bundled) as unknown as GatewayConfig);
  const merged = overlay(base, await loadRegistry(env));
  // Defaults again: a D1 row carries only what the operator set.
  const cfg = validateConfig(applyDefaults(merged));
  cache = { cfg, at: now };
  return cfg;
}

/** Drop the config cache — called after a console write so the change is live in this
 *  isolate immediately instead of after the TTL. */
export function invalidateConfig(): void {
  cache = null;
}
