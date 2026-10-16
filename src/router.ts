import type { GatewayConfig, ProviderEntry, ResolvedRoute } from "./types";

/** Model resolution: `{provider}:{model}` (or `{provider}/{model}`) → a provider entry.
 *
 *  A map keyed by prefix: O(1), and it makes the provider list *data* rather than a
 *  hand-maintained table of near-identical entries.
 *
 *  Splitting on the FIRST separator is what makes the convention work:
 *    openrouter/deepseek/deepseek-v4  → openrouter + "deepseek/deepseek-v4"
 *    nvidia_nim:meta/llama-3.1-8b     → nvidia_nim + "meta/llama-3.1-8b"
 *    myprov/qwen:7b                   → myprov + "qwen:7b"      (colon after slash is
 *                                        part of the model id, not a separator)
 *    gpt-5                            → no prefix → catch-all, whole string preserved
 *  Splitting on whichever separator comes first handles the third case by construction. */

/** Split a model id into (prefix, rest) at the first `:` or `/`. */
export function splitModel(model: string): { prefix: string | null; rest: string } {
  const colon = model.indexOf(":");
  const slash = model.indexOf("/");
  const idx =
    colon === -1 ? slash : slash === -1 ? colon : Math.min(colon, slash);
  if (idx <= 0) return { prefix: null, rest: model };
  return { prefix: model.slice(0, idx), rest: model.slice(idx + 1) };
}

/** Follow the alias chain to a canonical provider name. Bounded so a config typo that
 *  creates a cycle (`a → b → a`) can't hang a request. */
function canonical(cfg: GatewayConfig, name: string): string {
  let cur = name;
  for (let i = 0; i < 8; i++) {
    const next = cfg.aliases?.[cur];
    if (!next || next === cur) return cur;
    cur = next;
  }
  return cur;
}

function live(cfg: GatewayConfig, name: string): ProviderEntry | null {
  const p = cfg.providers[canonical(cfg, name)];
  if (!p || p.enabled === false) return null;
  return p;
}

/** Resolve an incoming `model` to a provider.
 *
 *  Unknown prefixes fall through to the catch-all with the WHOLE model string preserved
 *  — NOT the remainder. `some-vendor/some-model` must reach the catch-all provider
 *  intact, because to that provider the entire string is the model id. */
export function resolveRoute(cfg: GatewayConfig, model: string): ResolvedRoute | null {
  const { prefix, rest } = splitModel(model);

  if (prefix) {
    const entry = live(cfg, prefix);
    if (entry) return { entry, modelId: rest, provider: canonical(cfg, prefix) };
  }

  if (!cfg.catchAll) return null;
  const fallback = live(cfg, cfg.catchAll);
  if (!fallback) return null;
  return { entry: fallback, modelId: model, provider: canonical(cfg, cfg.catchAll) };
}

/** The model id that actually goes upstream.
 *
 *  Normally the bare remainder (the provider's own id space), but a `keepPrefix` entry
 *  gets the WHOLE string back: an AI Gateway dynamic route is addressed as the literal
 *  model `dynamic/{route-name}`, so the prefix is part of the id rather than routing
 *  metadata. Kept next to resolveRoute — the prefix is stripped here, so the one
 *  exception to stripping belongs here too, not scattered in dispatch. */
export function outboundModel(route: ResolvedRoute, model: string): string {
  return route.entry.keepPrefix ? model : route.modelId;
}
