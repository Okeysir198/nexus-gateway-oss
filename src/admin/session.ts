import type { Env } from "../types";

/** Signed, stateless admin sessions.
 *
 *  Token = base64url(payload) "." base64url(HMAC-SHA256(payload)). Stateless because a
 *  session table would need its own GC and buys little here. The payload is only
 *  `{ e: email, exp }` — the allowlist is checked AT LOGIN (isOperator), not per
 *  request, so verification is signature → expiry → email and touches NO database.
 *
 *  The signing key is derived from ADMIN_SESSION_SECRET (its own secret, not the master
 *  key, which stays a machine credential). With the secret UNSET nothing is signed or
 *  accepted: an empty secret would give a publicly known key, i.e. forgeable sessions.
 *  Rotating the secret signs every operator out everywhere; there is no per-user
 *  revocation. Removing an address from OPERATOR_EMAILS blocks the NEXT login only;
 *  outstanding cookies run out at the 12h TTL.
 *
 *  The :v2 domain separation makes tokens from any older scheme fail verification. */

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

export function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function signingKey(env: Env): Promise<CryptoKey> {
  // Domain-separated from any other use of the secret.
  const material = new TextEncoder().encode(`nexus-admin-session:v2:${env.ADMIN_SESSION_SECRET ?? ""}`);
  const digest = await crypto.subtle.digest("SHA-256", material);
  return crypto.subtle.importKey("raw", digest, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function mintSession(env: Env, email: string): Promise<string> {
  if (!env.ADMIN_SESSION_SECRET) throw new Error("ADMIN_SESSION_SECRET is not set");
  const payload: Session = { e: email, exp: Math.floor(Date.now() / 1000) + TTL_S };
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await signingKey(env);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `${body}.${b64url(new Uint8Array(sig))}`;
}

/** Verify a session token. Returns the operator EMAIL, or null.
 *  Signature → expiry → email present; nothing else to check — there is no row. */
export async function verifySession(env: Env, token: string | null): Promise<string | null> {
  if (!token || !env.ADMIN_SESSION_SECRET) return null;
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

/** CSRF: SameSite=Strict already stops the browser attaching our cookie to cross-site
 *  requests. This header is defence in depth — a cross-origin caller cannot set a custom
 *  header without a CORS preflight, which we never answer. Simple requests (forms,
 *  img/script tags) therefore cannot reach a state-changing route. */
export function csrfOk(request: Request): boolean {
  if (request.method === "GET" || request.method === "HEAD") return true;
  return request.headers.get("x-nexus-console") === "1";
}
