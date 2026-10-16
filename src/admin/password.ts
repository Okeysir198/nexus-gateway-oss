import { safeEqualBytes } from "../auth";
import { b64url, b64urlDecode } from "./session";

/** Shared-password sign-in for the console (optional, off unless ADMIN_PASSWORD_HASH is set).
 *
 *  One password for the whole operator team, stored ONLY as a salted PBKDF2-SHA256 hash in
 *  a Worker secret. There is no user table and no per-user identity: a password session is
 *  labelled PASSWORD_IDENTITY. It sits beside Google sign-in and does not consult
 *  OPERATOR_EMAILS — knowing the password is the whole gate, so make it long and random.
 *
 *  Stored format: `pbkdf2-sha256$<iterations>$<salt b64url>$<hash b64url>`, produced by
 *  `node scripts/hash-password.mjs`. workerd refuses PBKDF2 above 100,000 iterations, so
 *  that is both the default and the ceiling. */

export const PASSWORD_IDENTITY = "shared-password";
const MAX_ITERATIONS = 100_000;
const MAX_PASSWORD_LEN = 256;
const SALT_BYTES = 16;
const HASH_BYTES = 32;

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    key,
    HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/** Hash a password into the stored format. Used by tests; the CLI script mirrors it. */
export async function hashPassword(password: string, iterations = MAX_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, iterations);
  return `pbkdf2-sha256$${iterations}$${b64url(salt)}$${b64url(hash)}`;
}

/** True only for a well-formed stored hash that the password reproduces. A malformed or
 *  empty `stored` is FALSE, never an exception and never a pass. */
export async function verifyPassword(stored: string | undefined, password: string): Promise<boolean> {
  if (!stored || password.length === 0 || password.length > MAX_PASSWORD_LEN) return false;
  const parts = stored.trim().split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2-sha256") return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > MAX_ITERATIONS) return false;
  try {
    const salt = b64urlDecode(parts[2]!);
    const want = b64urlDecode(parts[3]!);
    if (salt.length < 8 || want.length !== HASH_BYTES) return false;
    return safeEqualBytes(await derive(password, salt, iterations), want);
  } catch {
    return false;
  }
}

// ── Failure throttle ────────────────────────────────────────────────────────────────
// Per-isolate and in memory: it slows a single client hammering one location, nothing
// more. Isolates are many and short-lived, so it is NOT a global limit. For a real one,
// put a Cloudflare rate-limiting rule on POST /login/password (see the runbook).
const MAX_FAILURES = 5;
const WINDOW_MS = 15 * 60_000;
const MAX_TRACKED = 1000;
const failures = new Map<string, { n: number; first: number }>();

/** Seconds until `key` may try again, or 0 when it may. */
export function lockedFor(key: string, now = Date.now()): number {
  const f = failures.get(key);
  if (!f) return 0;
  if (now - f.first > WINDOW_MS) {
    failures.delete(key);
    return 0;
  }
  return f.n >= MAX_FAILURES ? Math.ceil((f.first + WINDOW_MS - now) / 1000) : 0;
}

export function recordFailure(key: string, now = Date.now()): void {
  const f = failures.get(key);
  if (f && now - f.first <= WINDOW_MS) {
    f.n++;
    return;
  }
  if (failures.size >= MAX_TRACKED) failures.delete(failures.keys().next().value as string);
  failures.set(key, { n: 1, first: now });
}

export function clearFailures(key: string): void {
  failures.delete(key);
}

/** Test hook: forget every tracked client. */
export function resetThrottle(): void {
  failures.clear();
}
