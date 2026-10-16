import { afterEach, describe, expect, it, vi } from "vitest";
import { AigError, ensureCustomProvider, validateBaseUrl } from "../src/aig_providers";
import type { Env } from "../src/types";

const env = { CF_ACCOUNT_ID: "acc", AIG_API_TOKEN: "tok-secret" } as unknown as Env;

afterEach(() => vi.restoreAllMocks());

function cfReply(result: unknown, ok = true, status = 200) {
  return new Response(JSON.stringify(ok ? { success: true, result } : { success: false, errors: [{ message: "nope" }] }), { status });
}

describe("validateBaseUrl", () => {
  it("accepts a bare https host and drops a trailing slash", () => {
    expect(validateBaseUrl("https://api.example.com/", "gw.example.org")).toBe("https://api.example.com");
  });

  it("rejects what AI Gateway or the loop guard cannot use", () => {
    for (const bad of [
      "http://api.example.com",
      "https://api.example.com/v1",
      "https://api.example.com/?a=1",
      "https://user:pw@api.example.com",
      "https://localhost",
      "https://127.0.0.1",
      "https://svc.internal",
      "https://[::1]",
      "not a url",
      "https://gw.example.org",
      42,
    ]) {
      expect(() => validateBaseUrl(bad, "gw.example.org"), String(bad)).toThrow(AigError);
    }
  });
});

describe("ensureCustomProvider", () => {
  it("registers a provider that is missing, with the bare slug", async () => {
    const calls: { url: string; method: string; body?: unknown }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      calls.push({ url: String(input), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return cfReply(init?.method === "POST" ? { id: "x" } : []);
    });
    expect(await ensureCustomProvider(env, "custom-myprov", "https://api.myprov.com")).toBe("registered");
    expect(calls[0]!.url).toContain("/accounts/acc/ai-gateway/custom-providers");
    expect(calls[1]).toMatchObject({
      method: "POST",
      body: { slug: "myprov", base_url: "https://api.myprov.com", enable: true },
    });
  });

  it("leaves a provider that already points at the same URL alone", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      cfReply([{ slug: "myprov", base_url: "https://api.myprov.com/" }]),
    );
    expect(await ensureCustomProvider(env, "custom-myprov", "https://api.myprov.com")).toBe("exists");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("refuses to repoint an existing provider", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(cfReply([{ slug: "myprov", base_url: "https://other.example.com" }]));
    await expect(ensureCustomProvider(env, "custom-myprov", "https://api.myprov.com")).rejects.toThrow(/different base URL/);
  });

  it("reports Cloudflare's refusal without leaking the token", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(cfReply(null, false, 403));
    const err = await ensureCustomProvider(env, "custom-myprov", "https://api.myprov.com").catch((e: Error) => e);
    expect(err).toBeInstanceOf(AigError);
    expect((err as Error).message).toContain("nope");
    expect((err as Error).message).not.toContain("tok-secret");
  });

  it("needs the token", async () => {
    await expect(ensureCustomProvider({ CF_ACCOUNT_ID: "acc" } as unknown as Env, "custom-x", "https://a.example.com")).rejects.toThrow(/AIG_API_TOKEN/);
  });
});
