import { afterEach, describe, expect, it, vi } from "vitest";
import { googleCallback, googleStart } from "../src/admin/login";
import { googleLoginUrl, isOperator } from "../src/admin/google";
import {
  b64url,
  clearCookie,
  mintSession,
  readCookie,
  randomB64url,
  sessionCookie,
  verifySession,
} from "../src/admin/session";
import type { Env } from "../src/types";

/** The Google-only console gate's moving parts: the stateless HMAC session (mint →
 *  verify, and every way it must refuse) and the OPERATOR_EMAILS allowlist (which must
 *  fail CLOSED). Runs inside workerd so crypto.subtle behaves as in production. */

const env = (over: Partial<Env> = {}): Env =>
  ({ ADMIN_SESSION_SECRET: "test-secret", OPERATOR_EMAILS: "", ...over }) as Env;

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

describe("session roundtrip", () => {
  it("mints a token that verifies back to the operator email", async () => {
    const token = await mintSession(env(), "op@example.com");
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(await verifySession(env(), token)).toBe("op@example.com");
  });

  it("carries the cookie flags the CSRF story depends on", () => {
    const c = sessionCookie("tok");
    expect(c).toContain("nexus_admin=tok");
    expect(c).toContain("HttpOnly");
    expect(c).toContain("Secure");
    expect(c).toContain("SameSite=Strict");
    expect(c).toContain("Max-Age=43200"); // 12h
  });

  it("readCookie pulls the session out of a Cookie header", () => {
    const req = new Request("https://x/admin", { headers: { cookie: "other=1; nexus_admin=tok.junk" } });
    expect(readCookie(req)).toBe("tok.junk");
    expect(readCookie(new Request("https://x/admin"))).toBeNull();
  });

  it("clearCookie kills the session, and the state cookie gets its own name", () => {
    expect(clearCookie()).toMatch(/^nexus_admin=;/);
    expect(clearCookie("g_state")).toMatch(/^g_state=;/);
  });
});

describe("session refuses", () => {
  it("a tampered signature", async () => {
    const token = await mintSession(env(), "op@example.com");
    const [body, sig] = token.split(".");
    // Change the FIRST signature character: always a different value, and it carries all six
    // bits (the last character of a base64url string can be padding bits that decode alike).
    const flipped = (sig![0] === "A" ? "B" : "A") + sig!.slice(1);
    expect(await verifySession(env(), `${body}.${flipped}`)).toBeNull();
  });

  it("a tampered payload", async () => {
    const token = await mintSession(env(), "op@example.com");
    const [ , sig] = token.split(".");
    const forged = b64url(new TextEncoder().encode(JSON.stringify({ e: "attacker@example.com", exp: Math.floor(Date.now() / 1000) + 3600 })));
    expect(await verifySession(env(), `${forged}.${sig}`)).toBeNull();
  });

  it("an expired token", async () => {
    const token = await mintSession(env(), "op@example.com");
    // The TTL is 12h; 13h later the same token must be dead.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 13 * 3600_000);
    try {
      expect(await verifySession(env(), token)).toBeNull();
      // ...and a freshly minted one at the shifted time is still alive (expiry, not
      // the mint, is what the check reads).
      const fresh = await mintSession(env(), "op@example.com");
      expect(await verifySession(env(), fresh)).toBe("op@example.com");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a token minted under a different secret", async () => {
    const token = await mintSession(env({ ADMIN_SESSION_SECRET: "secret-a" }), "op@example.com");
    expect(await verifySession(env({ ADMIN_SESSION_SECRET: "secret-b" }), token)).toBeNull();
  });

  it("fails closed with no ADMIN_SESSION_SECRET: nothing is minted, and a token signed with the empty-secret key is refused", async () => {
    await expect(mintSession(env({ ADMIN_SESSION_SECRET: undefined }), "op@example.com")).rejects.toThrow(/ADMIN_SESSION_SECRET/);
    // Without this guard the signing key would be derived from the constant prefix alone,
    // i.e. publicly known, and anyone could forge an operator session.
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("nexus-admin-session:v2:"));
    const key = await crypto.subtle.importKey("raw", digest, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const body = b64url(new TextEncoder().encode(JSON.stringify({ e: "attacker@example.com", exp: Math.floor(Date.now() / 1000) + 3600 })));
    const sig = b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))));
    expect(await verifySession(env({ ADMIN_SESSION_SECRET: undefined }), `${body}.${sig}`)).toBeNull();
    expect(await verifySession(env({ ADMIN_SESSION_SECRET: "" }), `${body}.${sig}`)).toBeNull();
  });

  it("an unset secret, garbage, and nothing at all", async () => {
    const token = await mintSession(env({ ADMIN_SESSION_SECRET: "real" }), "op@example.com");
    expect(await verifySession(env({ ADMIN_SESSION_SECRET: undefined }), token)).toBeNull();
    expect(await verifySession(env(), "not-a-token")).toBeNull();
    expect(await verifySession(env(), null)).toBeNull();
  });

  it("a token from an older scheme does not verify — :v2 domain separation", async () => {
    // A payload in the old {u, exp, ep} shape: the :v2 key never signed it, and even a
    // signature collision would fail the missing `e`.
    expect(await verifySession(env(), "eyJ1IjoiYWRtaW4iLCJleHAiOjk5OTk5OTk5OTksImVwIjoxfQ.AAAA")).toBeNull();
  });
});

describe("isOperator — fail closed", () => {
  it("an EMPTY list denies everyone, however plausible the email", () => {
    expect(isOperator("", "op1@example.com")).toBe(false);
    expect(isOperator("   ", "op1@example.com")).toBe(false);
    expect(isOperator(",", "a@b.com")).toBe(false);
  });

  it("tolerates whitespace and case on both sides", () => {
    expect(isOperator(" A@B.com , c@D.era ", "a@b.COM")).toBe(true);
    expect(isOperator("a@b.com,c@d.era", "  C@D.ERA ")).toBe(true);
  });

  it("admits exactly the listed addresses", () => {
    const ops = "op1@example.com,op2@example.com";
    expect(isOperator(ops, "op1@example.com")).toBe(true);
    expect(isOperator(ops, "op2@example.com")).toBe(true);
    expect(isOperator(ops, "stranger@example.com")).toBe(false);
    // Not a substring match: the allowlist is exact addresses.
    expect(isOperator(ops, "op1@example.com.evil.io")).toBe(false);
  });
});

describe("googleLoginUrl", () => {
  it("asks Google the one login question, with the state echoed", () => {
    const url = new URL(googleLoginUrl("cid", "https://gateway.example.com/oauth/google/callback", "st-1"));
    expect(url.toString().startsWith(AUTH_URL)).toBe(true);
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("redirect_uri")).toBe("https://gateway.example.com/oauth/google/callback");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("openid email");
    expect(url.searchParams.get("prompt")).toBe("select_account");
    expect(url.searchParams.get("state")).toBe("st-1");
  });
});

describe("the handshake routes", () => {
  it("googleStart mints the Lax state cookie and 303s to Google", () => {
    const res = googleStart(env({ GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "sec" }), new Request("https://gateway.example.com/login/google"));
    expect(res.status).toBe(303);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.host).toBe("accounts.google.com");
    expect(loc.searchParams.get("redirect_uri")).toBe("https://gateway.example.com/oauth/google/callback");
    const sc = res.headers.get("set-cookie")!;
    expect(sc).toContain("g_state=");
    expect(sc).toContain("HttpOnly");
    expect(sc).toContain("SameSite=Lax"); // Strict would be stripped on the redirect back
  });

  it("googleStart 503s when unconfigured — clean failure, not a crash", () => {
    expect(googleStart({} as Env, new Request("https://x/login/google")).status).toBe(503);
  });

  it("the callback refuses a state mismatch before any network call", async () => {
    const res = await googleCallback(
      env({ GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "sec" }),
      new Request("https://x/oauth/google/callback?code=c&state=evil"),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("could not be verified");
  });
});

describe("helpers the rest of the Worker borrows", () => {
  it("randomB64url is url-safe and fresh", () => {
    for (let i = 0; i < 20; i++) {
      expect(randomB64url(16)).toMatch(/^[A-Za-z0-9_-]{22}$/); // 16 bytes → 22 chars, no padding
    }
    expect(randomB64url(16)).not.toBe(randomB64url(16));
  });
});

afterEach(() => {
  vi.useRealTimers();
});
