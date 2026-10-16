import type { Env } from "../types";

/** Signed, stateless admin sessions.
 *
 *  Token = base64url(payload) "." base64url(HMAC-SHA256(payload)). Stateless because a
 *  session table would need its own GC and buys little here. The payload is only
 *  `{ e: email, exp }` — the allowlist is checked AT LOGIN (isOperator), not per
 *  request, so verification is signature → expiry → email and touches NO database.
 *
 *  The signing key is derived from ADMIN_SESSION_SECRET (its own secret, not the master
 *  key — the master key remains a machine credential and no longer mixes into anything
 *  human-facing). Consequence, by design: rotating ADMIN_SESSION_SECRET signs every
 *  operator out everywhere. There is no per-user revocation any more — an operator is
 *  switched off by removing their address from OPERATOR_EMAILS (blocks the NEXT login;
 *  outstanding cookies run out at the 12h TTL) or by rotating the secret (blocks
 *  everything at once).
 *
 *  Operators live in the OPERATOR_EMAILS var, not in D1. The :v2 domain separation
 *  makes tokens from any older scheme fail verification. */

const COOKIE = "nexus_admin";
const TTL_S = 12 * 3600;

export interface Session {
  e: string; // operator email
  exp: number; // epoch seconds
}

/** bytes → base64url. Exported because the same encoding backs the session token, the
 *  virtual-key tokens (keys_db) and the per-response CSP nonces (page.ts) — it had drifted
 *  into four private copies of the identical `.replace` triple. */
export function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** n cryptographically random bytes, base64url-encoded. */
export function randomB64url(n: number): string {
  return b64url(crypto.getRandomValues(new Uint8Array(n)));
}

function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function signingKey(env: Env): Promise<CryptoKey> {
  // Domain-separated from any other use of the secret. :v2 = the Google-only era; the
  // :v1 tokens were keyed off NEXUS_MASTER_KEY and die here by construction.
  const material = new TextEncoder().encode(`nexus-admin-session:v2:${env.ADMIN_SESSION_SECRET ?? ""}`);
  const digest = await crypto.subtle.digest("SHA-256", material);
  return crypto.subtle.importKey("raw", digest, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function mintSession(env: Env, email: string): Promise<string> {
  const payload: Session = { e: email, exp: Math.floor(Date.now() / 1000) + TTL_S };
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await signingKey(env);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `${body}.${b64url(new Uint8Array(sig))}`;
}

/** Verify a session token. Returns the operator EMAIL, or null.
 *  Signature → expiry → email present; nothing else to check — there is no row. */
export async function verifySession(env: Env, token: string | null): Promise<string | null> {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;

  const key = await signingKey(env);
  let ok = false;
  try {
    ok = await crypto.subtle.verify("HMAC", key, b64urlDecode(sig) as BufferSource, new TextEncoder().encode(body));
  } catch {
    return null;
  }
  if (!ok) return null;

  let payload: Session;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body))) as Session;
  } catch {
    return null;
  }
  if (!payload.e || !payload.exp || payload.exp * 1000 < Date.now()) return null;
  return payload.e;
}

export function readCookie(request: Request, name = COOKIE): string | null {
  const raw = request.headers.get("Cookie") ?? "";
  const m = raw.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m?.[1] ?? null;
}

/** Secure by default: HttpOnly (no JS access → an XSS can't exfiltrate the session),
 *  Secure (HTTPS only), SameSite=Strict (the primary CSRF defence — the browser will not
 *  attach this cookie to any cross-site request, including form POSTs). The OAuth
 *  handshake's own `g_state` cookie is SameSite=Lax instead — it must survive the
 *  top-level redirect back from accounts.google.com. */
export function sessionCookie(token: string): string {
  return `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${TTL_S}`;
}

/** Clear a cookie. The session is Strict; the OAuth `g_state` (Lax) is cleared by name
 *  at the end of the handshake. */
export function clearCookie(name = COOKIE): string {
  const samesite = name === COOKIE ? "Strict" : "Lax";
  return `${name}=; HttpOnly; Secure; SameSite=${samesite}; Path=/; Max-Age=0`;
}
