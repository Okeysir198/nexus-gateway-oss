import type { Env, KeyPoolConfig } from "./types";

interface PoolState {
  cursor: number;
  cooldownUntil: number[]; // epoch ms per secret index; 0 = available
}

/** In-isolate pool state, keyed by POOL NAME. Per-isolate is best-effort (a 429 in
 *  isolate A is not instantly visible to isolate B); that is acceptable for throughput
 *  spread on the NVIDIA 6-key pool. For strict cross-isolate cooldown, a KeyPoolDO can
 *  later own the cursor. */
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
    // `idx` is in range by construction, but a config whose `secrets` array is shorter
    // than its live indices would hand back undefined and send an empty bearer upstream.
    // Skipping is strictly better than authenticating as nobody.
    if (idx === undefined) continue;
    const secret = cfg.secrets[idx];
    if (secret === undefined) continue;
    const cooled = s.cooldownUntil[idx];
    if (!cooled || cooled <= now) {
      s.cursor = (s.cursor + step) % live.length;
      return { secret, index: idx };
    }
  }
  // all cooled — fall back to the cursor's key anyway (let the upstream 429 again).
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
