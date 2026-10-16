import type { Env, GatewayConfig, KeyPoolConfig, ResolvedRoute } from "../types";
import { pick } from "../keypool";

/** Resolve the outbound auth key for a route: pooled (round-robin + cooldown) or
 *  single-secret. Returns the next key to try, or null if none is configured. */
export function pickKey(cfg: GatewayConfig, route: ResolvedRoute, env: Env): { value: string; pool?: KeyPoolConfig; index?: number } | null {
  const entry = route.entry;
  if (entry.keyPool) {
    const pool = cfg.keyPools[entry.keyPool];
    if (!pool) return null;
    const chosen = pick(entry.keyPool, pool, env);
    if (!chosen) return null;
    const value = String((env as unknown as Record<string, unknown>)[chosen.secret] ?? "");
    return { value, pool, index: chosen.index };
  }
  if (entry.secret) {
    return { value: String((env as unknown as Record<string, unknown>)[entry.secret] ?? "") };
  }
  return null;
}
