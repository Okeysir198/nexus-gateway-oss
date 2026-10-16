import type { Env, KeyPoolConfig } from "./types";

interface PoolState {
  cursor: number;
  cooldownUntil: number[]; // epoch ms per secret index; 0 = available
}

/** In-isolate pool state, keyed by POOL NAME. Per-isolate is best-effort (a 429 in one
 *  isolate is not visible to another), which is enough to spread load across keys. */
const pools = new Map<string, PoolState>();

function state(name: string, cfg: KeyPoolConfig): PoolState {
  let s = pools.get(name);
  if (!s) {
    s = { cursor: 0, cooldownUntil: new Array(cfg.secrets.length).fill(0) };
    pools.set(name, s);
  }
  return s;
}

/** The live (non-empty) secret indices for a pool, in declaration order. */
export function liveIndices(cfg: KeyPoolConfig, env: Env): number[] {
  const out: number[] = [];
  cfg.secrets.forEach((name, i) => {
    if (String((env as unknown as Record<string, unknown>)[name] ?? "")) out.push(i);
  });
  return out;
}

/** Pick the next available key (simple-shuffle = round-robin skipping cooled keys).
 *  Returns the secret env name + its index, or null if the pool is empty/all-cooled. */
export function pick(name: string, cfg: KeyPoolConfig, env: Env): { secret: string; index: number } | null {
  const live = liveIndices(cfg, env);
  if (!live.length) return null;
  const s = state(name, cfg);
  const now = Date.now();
  s.cursor = (s.cursor + 1) % live.length;
  for (let step = 0; step < live.length; step++) {
    const idx = live[(s.cursor + step) % live.length];
    // In range by construction; skipping beats sending an empty bearer if it ever is not.
    if (idx === undefined) continue;
    const secret = cfg.secrets[idx];
    if (secret === undefined) continue;
    const cooled = s.cooldownUntil[idx];
    if (!cooled || cooled <= now) {
      s.cursor = (s.cursor + step) % live.length;
      return { secret, index: idx };
    }
  }
  // All cooled: use the cursor's key anyway and let the upstream 429 again.
  const idx = live[s.cursor % live.length];
  if (idx === undefined) return null;
  const secret = cfg.secrets[idx];
  return secret === undefined ? null : { secret, index: idx };
}

/** Park a key after a 429. */
export function markCooldown(name: string, cfg: KeyPoolConfig, index: number): void {
  const s = state(name, cfg);
  s.cooldownUntil[index] = Date.now() + cfg.cooldownMs;
}
