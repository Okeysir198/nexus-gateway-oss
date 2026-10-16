import { beforeEach, describe, expect, it } from "vitest";
import {
  decryptKey,
  deleteProviderKey,
  encryptKey,
  invalidateProviderKeys,
  listStoredKeys,
  referencedSecrets,
  saveProviderKey,
  withProviderKeys,
} from "../src/provider_keys";
import type { Env, GatewayConfig } from "../src/types";

/** Provider keys stored from the console: the encryption, the rule that only names the
 *  config already uses can be stored, Worker secrets beating stored keys, and the overlay
 *  never touching anything else on env. D1 is faked in memory. */

function fakeD1() {
  const rows = new Map<string, { ciphertext: string; hint: string; updated_at: number; updated_by: string | null }>();
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    run: async () => {
      if (sql.startsWith("INSERT INTO provider_keys")) {
        rows.set(args[0] as string, {
          ciphertext: args[1] as string,
          hint: args[2] as string,
          updated_at: args[3] as number,
          updated_by: args[4] as string,
        });
      } else if (sql.startsWith("DELETE FROM provider_keys")) {
        return { meta: { changes: rows.delete(args[0] as string) ? 1 : 0 } };
      }
      return { meta: { changes: 0 } };
    },
    all: async () => ({
      results: [...rows].map(([secret_name, r]) => ({ secret_name, ...r })),
    }),
  });
  return { prepare: (sql: string) => stmt(sql), rows };
}

const cfg = {
  providers: {
    groq: { slug: "groq", secret: "GROQ_API_KEY" },
    nvidia_nim: { slug: "custom-nvidia", keyPool: "nvidia_nim" },
    byok_only: { slug: "x" },
  },
  keyPools: { nvidia_nim: { secrets: ["NVIDIA_API_KEY", "NVIDIA_API_KEY_02"], cooldownMs: 1000 } },
} as unknown as GatewayConfig;

const mkEnv = (over: Record<string, unknown> = {}) => {
  const db = fakeD1();
  return { env: { KEYS_DB: db, NEXUS_MASTER_KEY: "master-1", ...over } as unknown as Env, db };
};

beforeEach(() => invalidateProviderKeys());

describe("referencedSecrets", () => {
  it("lists single secrets and pool members, with who uses them", () => {
    const m = referencedSecrets(cfg);
    expect([...m.keys()].sort()).toEqual(["GROQ_API_KEY", "NVIDIA_API_KEY", "NVIDIA_API_KEY_02"]);
    expect(m.get("NVIDIA_API_KEY")).toEqual(["nvidia_nim"]);
  });

  it("ignores names that are not secret-shaped", () => {
    const bad = { providers: { p: { slug: "s", secret: "kEYS_DB" } }, keyPools: {} } as unknown as GatewayConfig;
    expect(referencedSecrets(bad).size).toBe(0);
  });
});

describe("encryption", () => {
  it("round-trips and never stores the plaintext", async () => {
    const { env } = mkEnv();
    const ct = await encryptKey(env, "GROQ_API_KEY", "gsk_test_value_123");
    expect(ct).toMatch(/^v1\.[\w-]+\.[\w-]+$/);
    expect(ct).not.toContain("gsk_test");
    expect(await decryptKey(env, "GROQ_API_KEY", ct)).toBe("gsk_test_value_123");
  });

  it("is bound to the secret name", async () => {
    const { env } = mkEnv();
    const ct = await encryptKey(env, "GROQ_API_KEY", "gsk_test_value_123");
    expect(await decryptKey(env, "OTHER_API_KEY", ct)).toBeNull();
  });

  it("fails to decrypt once the encryption secret changes, and KEY_ENCRYPTION_SECRET overrides the master key", async () => {
    const { env } = mkEnv();
    const ct = await encryptKey(env, "GROQ_API_KEY", "gsk_test_value_123");
    expect(await decryptKey({ ...env, NEXUS_MASTER_KEY: "master-2" } as Env, "GROQ_API_KEY", ct)).toBeNull();
    const withDedicated = { ...env, KEY_ENCRYPTION_SECRET: "dedicated" } as Env;
    const ct2 = await encryptKey(withDedicated, "GROQ_API_KEY", "gsk_other_value_9");
    expect(await decryptKey({ ...withDedicated, NEXUS_MASTER_KEY: "changed" } as Env, "GROQ_API_KEY", ct2)).toBe("gsk_other_value_9");
  });

  it("refuses to encrypt with no secret configured", async () => {
    const { env } = mkEnv({ NEXUS_MASTER_KEY: undefined });
    await expect(encryptKey(env, "GROQ_API_KEY", "gsk_test_value_123")).rejects.toThrow(/NEXUS_MASTER_KEY/);
  });
});

describe("saveProviderKey", () => {
  it("rejects names no provider uses, including core secrets and bindings", async () => {
    const { env } = mkEnv();
    for (const name of ["NEXUS_MASTER_KEY", "ADMIN_SESSION_SECRET", "KEYS_DB", "lowercase", "NOT_REFERENCED_KEY"]) {
      expect(await saveProviderKey(env, cfg, name, "abcdefgh12345", "op")).not.toBeNull();
    }
  });

  it("rejects short, long and whitespace-containing values", async () => {
    const { env } = mkEnv();
    expect(await saveProviderKey(env, cfg, "GROQ_API_KEY", "short", "op")).toMatch(/8 to/);
    expect(await saveProviderKey(env, cfg, "GROQ_API_KEY", "x".repeat(513), "op")).toMatch(/8 to/);
    expect(await saveProviderKey(env, cfg, "GROQ_API_KEY", "has a space inside", "op")).toMatch(/whitespace/);
  });

  it("stores ciphertext, keeps the last four characters as a hint, and lists metadata only", async () => {
    const { env, db } = mkEnv();
    expect(await saveProviderKey(env, cfg, "GROQ_API_KEY", "  gsk_abcdef1234  ", "op@example.com")).toBeNull();
    const row = db.rows.get("GROQ_API_KEY")!;
    expect(row.ciphertext).not.toContain("gsk_abcdef1234");
    expect(row.hint).toBe("1234");
    const listed = await listStoredKeys(env);
    expect(listed.get("GROQ_API_KEY")).toMatchObject({ hint: "1234", updated_by: "op@example.com" });
    expect(JSON.stringify([...listed])).not.toContain("gsk_abcdef");
  });

  it("deletes", async () => {
    const { env } = mkEnv();
    await saveProviderKey(env, cfg, "GROQ_API_KEY", "gsk_abcdef1234", "op");
    expect(await deleteProviderKey(env, "GROQ_API_KEY")).toBe(1);
    expect(await deleteProviderKey(env, "GROQ_API_KEY")).toBe(0);
  });
});

describe("withProviderKeys", () => {
  it("fills missing secrets from storage, for single secrets and pool members", async () => {
    const { env } = mkEnv();
    await saveProviderKey(env, cfg, "GROQ_API_KEY", "gsk_groq_value_1", "op");
    await saveProviderKey(env, cfg, "NVIDIA_API_KEY_02", "nvapi-second-key", "op");
    invalidateProviderKeys();
    const out = (await withProviderKeys(env, cfg)) as unknown as Record<string, unknown>;
    expect(out["GROQ_API_KEY"]).toBe("gsk_groq_value_1");
    expect(out["NVIDIA_API_KEY_02"]).toBe("nvapi-second-key");
    expect(out["NVIDIA_API_KEY"]).toBeUndefined();
  });

  it("lets a Worker secret win over a stored key", async () => {
    const { env } = mkEnv({ GROQ_API_KEY: "from-wrangler-secret" });
    await saveProviderKey(env, cfg, "GROQ_API_KEY", "gsk_console_value", "op");
    invalidateProviderKeys();
    const out = (await withProviderKeys(env, cfg)) as unknown as Record<string, unknown>;
    expect(out["GROQ_API_KEY"]).toBe("from-wrangler-secret");
  });

  it("keeps every binding and secret of the original env reachable", async () => {
    const { env } = mkEnv({ ADMIN_SESSION_SECRET: "s" });
    await saveProviderKey(env, cfg, "GROQ_API_KEY", "gsk_groq_value_1", "op");
    invalidateProviderKeys();
    const out = (await withProviderKeys(env, cfg)) as unknown as Record<string, unknown>;
    expect(out["KEYS_DB"]).toBe((env as unknown as Record<string, unknown>)["KEYS_DB"]);
    expect(out["ADMIN_SESSION_SECRET"]).toBe("s");
  });

  it("ignores a stored row whose name no provider references any more", async () => {
    const { env, db } = mkEnv();
    db.rows.set("OLD_PROVIDER_API_KEY", {
      ciphertext: await encryptKey(env, "OLD_PROVIDER_API_KEY", "old-value-12345"),
      hint: "2345",
      updated_at: 1,
      updated_by: "op",
    });
    const out = (await withProviderKeys(env, cfg)) as unknown as Record<string, unknown>;
    expect(out["OLD_PROVIDER_API_KEY"]).toBeUndefined();
  });

  it("treats an undecryptable row as missing instead of failing the request", async () => {
    const { env, db } = mkEnv();
    db.rows.set("GROQ_API_KEY", { ciphertext: "v1.garbage.garbage", hint: "xxxx", updated_at: 1, updated_by: "op" });
    const out = (await withProviderKeys(env, cfg)) as unknown as Record<string, unknown>;
    expect(out["GROQ_API_KEY"]).toBeUndefined();
  });
});
