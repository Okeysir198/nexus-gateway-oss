import { describe, expect, it } from "vitest";
import { adminApi } from "../src/admin/routes";
import { mintSession, sessionCookie } from "../src/admin/session";
import type { Env } from "../src/types";

/** The console API's request validation: gates and rejections that must answer before any
 *  database is touched (so no D1 is needed here). */

const env = { ADMIN_SESSION_SECRET: "test-secret" } as unknown as Env;

async function call(method: string, path: string, body?: unknown, signedIn = true) {
  const headers: Record<string, string> = { "x-nexus-console": "1", "content-type": "application/json" };
  if (signedIn) headers["cookie"] = sessionCookie(await mintSession(env, "op@example.com")).split(";")[0]!;
  const res = await adminApi(env, new Request("https://gateway.example.com" + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }), path);
  return res!;
}

describe("admin API gates", () => {
  it("401 without a session, 403 without the console header", async () => {
    expect((await call("POST", "/admin/api/provider-keys", { secret: "GROQ_API_KEY", value: "x" }, false)).status).toBe(401);
    const noHeader = await adminApi(env, new Request("https://gateway.example.com/admin/api/providers", {
      method: "POST",
      headers: { cookie: sessionCookie(await mintSession(env, "op@example.com")).split(";")[0]! },
      body: "{}",
    }), "/admin/api/providers");
    expect(noHeader!.status).toBe(403);
  });
});

describe("provider registry validation", () => {
  const base = { name: "myprov", slug: "custom-myprov" };

  it("rejects a secret that is not an env var NAME (a pasted key, a path, an object)", async () => {
    for (const secret of ["sk-live-abc123", "lower_case_key", "KEYS DB", { x: 1 }]) {
      const res = await call("POST", "/admin/api/providers", { ...base, secret });
      expect(res.status).toBe(400);
      expect(JSON.stringify(await res.json())).not.toContain("sk-live-abc123");
    }
  });

  it("rejects a base URL without the token, without custom-, or that is not a public https host", async () => {
    const noToken = await call("POST", "/admin/api/providers", { ...base, baseUrl: "https://api.example.com" });
    expect(noToken.status).toBe(400);
    expect(JSON.stringify(await noToken.json())).toContain("AIG_API_TOKEN");

    expect((await call("POST", "/admin/api/providers", { name: "x", slug: "groq", baseUrl: "https://api.example.com" })).status).toBe(400);

    // With the token set, a bad URL is refused before Cloudflare or the database is touched.
    const withToken = { ...env, AIG_API_TOKEN: "t", CF_ACCOUNT_ID: "a" } as unknown as Env;
    const headers = { "x-nexus-console": "1", "content-type": "application/json", cookie: sessionCookie(await mintSession(env, "op@example.com")).split(";")[0]! };
    const res = await adminApi(withToken, new Request("https://gateway.example.com/admin/api/providers", {
      method: "POST", headers, body: JSON.stringify({ ...base, baseUrl: "http://127.0.0.1:8080" }),
    }), "/admin/api/providers");
    expect(res!.status).toBe(400);
  });

  it("answers 400, not 500, to a malformed percent-escape in a path segment", async () => {
    expect((await call("DELETE", "/admin/api/providers/%E0%A4%A")).status).toBe(400);
    expect((await call("DELETE", "/admin/api/provider-keys/%E0%A4%A")).status).toBe(400);
    expect((await call("DELETE", "/admin/api/providers/alias/%E0%A4%A")).status).toBe(400);
  });
});

describe("provider keys API", () => {
  it("rejects a body missing the value and a secret name of the wrong shape", async () => {
    expect((await call("POST", "/admin/api/provider-keys", { secret: "GROQ_API_KEY" })).status).toBe(400);
    expect((await call("DELETE", "/admin/api/provider-keys/not_a_valid_name")).status).toBe(400);
  });
});
