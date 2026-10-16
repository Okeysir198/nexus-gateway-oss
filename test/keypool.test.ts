import { describe, expect, it } from "vitest";
import { liveIndices, markCooldown, pick } from "../src/keypool";
import type { Env, KeyPoolConfig } from "../src/types";

/** The NVIDIA 6-key rotation is the one capability AI Gateway can't provide, so it stays
 *  Worker-side and is worth pinning. Each test uses a DISTINCT pool name because cursor
 *  and cooldown state is module-level and shared across a process. */

const pool: KeyPoolConfig = {
  cooldownMs: 20_000,
  secrets: ["K1", "K2", "K3"],
};

const env = (over: Record<string, string> = {}) =>
  ({ K1: "v1", K2: "v2", K3: "v3", ...over }) as unknown as Env;

describe("keypool", () => {
  it("lists only secrets that have a value", () => {
    expect(liveIndices(pool, env())).toEqual([0, 1, 2]);
    expect(liveIndices(pool, env({ K2: "" }))).toEqual([0, 2]);
  });

  it("returns null when no secret is set", () => {
    expect(pick("p-empty", pool, env({ K1: "", K2: "", K3: "" }))).toBeNull();
  });

  it("rotates across the live keys rather than pinning one", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 6; i++) seen.add(pick("p-rotate", pool, env())!.secret);
    // The point of a pool: consecutive calls must not all land on the same key.
    expect(seen.size).toBeGreaterThan(1);
  });

  it("skips a key parked in cooldown", () => {
    const e = env();
    const first = pick("p-cool", pool, e)!;
    markCooldown("p-cool", pool, first.index);
    for (let i = 0; i < 5; i++) {
      expect(pick("p-cool", pool, e)!.index).not.toBe(first.index);
    }
  });

  it("still returns a key when EVERY key is cooling", () => {
    // Serving a likely-429 beats returning nothing — the caller can still surface the
    // upstream's own error instead of a synthetic gateway failure.
    const e = env();
    for (let i = 0; i < pool.secrets.length; i++) markCooldown("p-all", pool, i);
    expect(pick("p-all", pool, e)).not.toBeNull();
  });

  it("never returns a key whose secret is empty, even after cooldown churn", () => {
    const e = env({ K3: "" });
    for (let i = 0; i < 10; i++) {
      const got = pick("p-empty-secret", pool, e);
      expect(got!.secret).not.toBe("K3");
    }
  });
});
