import { describe, expect, it } from "vitest";
import { authenticate, requireMaster } from "../src/auth";
import { keyDelete, keyGenerate } from "../src/key_webhook";
import worker from "../src/index";
import type { Env } from "../src/types";

/** BYOK — a caller may present a cloud provider's OWN key in the Authorization slot
 *  instead of a nexus virtual key.
 *
 *  The whole mechanism hinges on one field: `authenticate()` returning `byokToken` on the
 *  miss path. What must be pinned is WHEN that field is absent, because every absence is a
 *  door that stays shut: no token at all, and a D1 outage (which is not evidence about the
 *  token either way). If a refactor starts populating byokToken on those paths, a D1
 *  outage silently turns every request into an unauthenticated upstream call. */

/** Minimal D1 double: one `first()` result, or an Error to throw. */
function env(result: unknown): Env {
  return {
    NEXUS_MASTER_KEY: "master-secret",
    KEYS_DB: {
      prepare() {
        return {
          bind() {
            return this;
          },
          async first() {
            if (result instanceof Error) throw result;
            return result ?? null;
          },
        };
      },
    },
  } as unknown as Env;
}

const req = (auth?: string) => new Request("https://gateway.example.com/v1/chat/completions", auth ? { headers: { Authorization: `Bearer ${auth}` } } : {});

describe("authenticate — BYOK candidate", () => {
  it("offers the token as a BYOK candidate when D1 has no such key", async () => {
    // Vary the token per test: authenticate() keeps a per-isolate cache keyed on it.
    const r = await authenticate(env(null), req("sk-or-v1-notavirtualkey"));
    expect(r.ok).toBe(false);
    expect(r.byokToken).toBe("sk-or-v1-notavirtualkey");
  });

  it("offers no candidate when no token was presented", async () => {
    const r = await authenticate(env(null), req());
    expect(r.ok).toBe(false);
    expect(r.byokToken).toBeUndefined();
  });

  it("offers no candidate when D1 itself is down", async () => {
    const r = await authenticate(env(new Error("D1 unavailable")), req("sk-byok-during-outage"));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("key store unavailable");
    expect(r.byokToken).toBeUndefined();
  });

  it("a valid virtual key authenticates normally and is not a BYOK candidate", async () => {
    const r = await authenticate(env({ key_alias: "my-app" }), req("sk-a-real-virtual-key"));
    expect(r.ok).toBe(true);
    expect(r.alias).toBe("my-app");
    expect(r.byokToken).toBeUndefined();
  });

  it("the master key is still its own fast path", async () => {
    const r = await authenticate(env(null), req("master-secret"));
    expect(r.ok).toBe(true);
    expect(r.alias).toBe("master");
    expect(r.byokToken).toBeUndefined();
  });

  it("the negative cache preserves the candidate on a repeat call", async () => {
    const e = env(null);
    const first = await authenticate(e, req("sk-repeat-me"));
    const second = await authenticate(e, req("sk-repeat-me"));
    expect(first.byokToken).toBe("sk-repeat-me");
    expect(second.byokToken).toBe("sk-repeat-me");
  });
});

describe("master key comparison", () => {
  const withKey = (key: string | undefined) =>
    new Request("https://gateway.example.com/key/list", key ? { headers: { Authorization: `Bearer ${key}` } } : {});

  it("accepts only the exact key", () => {
    expect(requireMaster(env(null), withKey("master-secret"))).toBeNull();
    for (const bad of ["master-secre", "master-secret2", "MASTER-SECRET", "", undefined]) {
      expect(requireMaster(env(null), withKey(bad))?.status).toBe(401);
    }
  });

  it("fails closed when no master key is configured", () => {
    const e = { ...env(null), NEXUS_MASTER_KEY: "" } as Env;
    expect(requireMaster(e, withKey("anything"))?.status).toBe(503);
  });
});

describe("machine endpoints reject malformed bodies instead of crashing", () => {
  const post = (body: string) =>
    new Request("https://gateway.example.com/key/delete", {
      method: "POST",
      headers: { Authorization: "Bearer master-secret", "content-type": "application/json" },
      body,
    });

  it("key/delete wants arrays of strings", async () => {
    for (const body of ["null", '"x"', '{"keys":"sk-abc"}', '{"key_ids":[1,2]}', '{"keys":{}}']) {
      expect((await keyDelete(env(null), post(body))).status).toBe(400);
    }
    expect((await keyDelete(env(null), post("{}"))).status).toBe(400);
  });

  it("key/generate treats a non-object body as empty rather than throwing", async () => {
    const db = { prepare: () => ({ bind() { return this; }, async run() { return {}; } }) };
    const e = { ...env(null), KEYS_DB: db } as unknown as Env;
    for (const body of ["null", "[]", '"x"', "5"]) {
      const res = await keyGenerate(e, post(body));
      expect(res.status).toBe(200);
      expect(((await res.json()) as { key: string }).key).toMatch(/^sk-/);
    }
  });
});

describe("chat requests with a bad body", () => {
  const e = { ...env(null), CF_ACCOUNT_ID: "a", AIG_GATEWAY_ID: "g" } as unknown as Env;
  e.KEYS_DB = { prepare: () => ({ bind() { return this; }, async first() { return null; }, async all() { throw new Error("no registry"); } }) } as unknown as Env["KEYS_DB"];
  const call = (path: string, body: string) =>
    worker.fetch(
      new Request(`https://gateway.example.com${path}`, {
        method: "POST",
        headers: { Authorization: "Bearer master-secret", "content-type": "application/json" },
        body,
      }),
      e,
      { waitUntil() {} } as unknown as ExecutionContext,
    );

  it("answers 400, not 500, when the JSON is not an object or `model` is not a string", async () => {
    for (const path of ["/v1/chat/completions", "/v1/messages"]) {
      for (const body of ["null", "[]", "5", '{"model":5}', '{"model":""}', "{}", "not json"]) {
        const res = await call(path, body);
        expect(res.status, `${path} ${body}`).toBe(400);
      }
    }
  });
});
