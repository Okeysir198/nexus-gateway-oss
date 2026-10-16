import { beforeEach, describe, expect, it } from "vitest";
import { PASSWORD_IDENTITY, hashPassword, lockedFor, recordFailure, resetThrottle, verifyPassword } from "../src/admin/password";
import { loginPage, passwordEnabled, passwordLogin, requireAdmin, signInOptions } from "../src/admin/login";
import type { Env } from "../src/types";

/** Shared-password sign-in: the hash format (including a hash made by the CLI script, which
 *  runs on Node, not workerd), every way verification must refuse, the throttle, the
 *  endpoint's gates, and the sign-in page only offering the form when it is configured. */

// Made by: printf 'correct horse battery staple 42' | node scripts/hash-password.mjs
const CLI_HASH = "pbkdf2-sha256$100000$ajBRSQ1OZFRpqRPg9kHu_w$x-DqEFV36DjDow7pyMEGsXgTIBW-wH4UbDCXCtPvDlQ";
const PASSWORD = "correct horse battery staple 42";

const env = (over: Partial<Env> = {}): Env =>
  ({ ADMIN_SESSION_SECRET: "test-secret", OPERATOR_EMAILS: "", ...over }) as Env;

const post = (body: unknown, headers: Record<string, string> = { "x-nexus-console": "1" }) =>
  new Request("https://gateway.example.com/login/password", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

beforeEach(() => resetThrottle());

describe("verifyPassword", () => {
  it("accepts a hash made by scripts/hash-password.mjs", async () => {
    expect(await verifyPassword(CLI_HASH, PASSWORD)).toBe(true);
  });

  it("round-trips its own hashes and salts each one", async () => {
    const a = await hashPassword("a long enough password");
    const b = await hashPassword("a long enough password");
    expect(a).not.toBe(b);
    expect(await verifyPassword(a, "a long enough password")).toBe(true);
    expect(await verifyPassword(a, "a long enough passworD")).toBe(false);
  });

  it("refuses the wrong password, empty input and oversize input", async () => {
    expect(await verifyPassword(CLI_HASH, "wrong")).toBe(false);
    expect(await verifyPassword(CLI_HASH, "")).toBe(false);
    expect(await verifyPassword(CLI_HASH, "x".repeat(257))).toBe(false);
  });

  it("is false, never a throw or a pass, for a missing or malformed stored hash", async () => {
    for (const bad of [undefined, "", "plaintext", "pbkdf2-sha256$100000$AAAA", "md5$1$a$b", "pbkdf2-sha256$0$AAAAAAAAAAAA$AAAA", "pbkdf2-sha256$9999999$AAAAAAAAAAAA$AAAA", "pbkdf2-sha256$100000$!!!$???"]) {
      expect(await verifyPassword(bad, PASSWORD)).toBe(false);
    }
  });
});

describe("throttle", () => {
  it("locks a client after five failures and not before", () => {
    for (let i = 0; i < 4; i++) recordFailure("c1");
    expect(lockedFor("c1")).toBe(0);
    recordFailure("c1");
    expect(lockedFor("c1")).toBeGreaterThan(0);
    expect(lockedFor("someone-else")).toBe(0);
  });

  it("forgets a client once the window has passed", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) recordFailure("c2", t0);
    expect(lockedFor("c2", t0 + 1000)).toBeGreaterThan(0);
    expect(lockedFor("c2", t0 + 16 * 60_000)).toBe(0);
  });
});

describe("POST /login/password", () => {
  it("is 404 when no hash is configured", async () => {
    expect(passwordEnabled(env())).toBe(false);
    expect((await passwordLogin(env(), post({ password: PASSWORD }))).status).toBe(404);
  });

  it("is 503 when ADMIN_SESSION_SECRET is missing, rather than minting an unsigned session", async () => {
    const res = await passwordLogin(env({ ADMIN_PASSWORD_HASH: CLI_HASH, ADMIN_SESSION_SECRET: undefined }), post({ password: PASSWORD }));
    expect(res.status).toBe(503);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("is 403 without the console header", async () => {
    const res = await passwordLogin(env({ ADMIN_PASSWORD_HASH: CLI_HASH }), post({ password: PASSWORD }, {}));
    expect(res.status).toBe(403);
  });

  it("is 400 for a body that is not JSON", async () => {
    expect((await passwordLogin(env({ ADMIN_PASSWORD_HASH: CLI_HASH }), post("not json"))).status).toBe(400);
  });

  it("is 401 for the wrong password and sets no cookie", async () => {
    const res = await passwordLogin(env({ ADMIN_PASSWORD_HASH: CLI_HASH }), post({ password: "nope" }));
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("mints a console session on the right password", async () => {
    const e = env({ ADMIN_PASSWORD_HASH: CLI_HASH });
    const res = await passwordLogin(e, post({ password: PASSWORD }));
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    const token = cookie.match(/nexus_admin=([^;]+)/)![1]!;
    const id = await requireAdmin(e, new Request("https://x/admin", { headers: { cookie: `nexus_admin=${token}` } }));
    expect(id).toEqual({ ok: true, email: PASSWORD_IDENTITY });
  });

  it("answers 429 with Retry-After after five wrong guesses, even for the right password", async () => {
    const e = env({ ADMIN_PASSWORD_HASH: CLI_HASH });
    for (let i = 0; i < 5; i++) expect((await passwordLogin(e, post({ password: "nope" }))).status).toBe(401);
    const res = await passwordLogin(e, post({ password: PASSWORD }));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});

describe("sign-in page", () => {
  const req = () => new Request("https://x/admin");

  it("offers Google only when no password is configured", async () => {
    const html = await loginPage(env(), req()).text();
    expect(html).not.toContain("pwForm");
    expect(html).not.toContain("<script");
  });

  it("adds the password form and one nonce'd script when configured, and keeps form-action 'none'", async () => {
    const res = loginPage(env({ ADMIN_PASSWORD_HASH: CLI_HASH, GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "sec" }), req());
    const html = await res.text();
    expect(html).toContain('id="pwForm"');
    expect(html).toContain('type="password"');
    const nonces = [...html.matchAll(/nonce="([^"]+)"/g)].map((m) => m[1]);
    expect(nonces).toHaveLength(2);
    expect(nonces[0]).toBe(nonces[1]);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain(`script-src 'nonce-${nonces[0]}'`);
    expect(csp).toContain("form-action 'none'");
    expect(csp).not.toContain("unsafe-inline");
  });
});

describe("which doors the sign-in page shows", () => {
  const google = { GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "sec" };

  it("shows Google alone when only Google is configured", () => {
    expect(signInOptions(env(google))).toEqual({ password: false, google: true });
  });

  it("shows both when both are configured", () => {
    expect(signInOptions(env({ ...google, ADMIN_PASSWORD_HASH: CLI_HASH }))).toEqual({ password: true, google: true });
  });

  it("hides the Google button when only the password is configured", async () => {
    expect(signInOptions(env({ ADMIN_PASSWORD_HASH: CLI_HASH }))).toEqual({ password: true, google: false });
    const html = await loginPage(env({ ADMIN_PASSWORD_HASH: CLI_HASH }), new Request("https://x/admin")).text();
    expect(html).toContain('id="pwForm"');
    expect(html).not.toContain("/login/google");
    expect(html).not.toContain("aria-hidden=\"true\"><span class=\"h-px");
  });

  it("still shows Google when nothing is configured, so its 503 explains what is missing", () => {
    expect(signInOptions(env())).toEqual({ password: false, google: true });
  });
});
