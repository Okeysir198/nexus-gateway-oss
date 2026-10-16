import { describe, expect, it } from "vitest";
import { authenticate } from "../src/auth";
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
