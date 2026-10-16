// The console password hash, shared by scripts/hash-password.mjs and scripts/deploy.mjs.
// Format (verified by src/admin/password.ts): pbkdf2-sha256$<iterations>$<salt>$<hash>, base64url.
// 100,000 is the most iterations workerd's PBKDF2 accepts, so do not raise it.
import { pbkdf2Sync, randomBytes } from "node:crypto";

export const ITERATIONS = 100_000;
export const b64url = (buf) => buf.toString("base64url");

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(password, salt, ITERATIONS, 32, "sha256");
  return `pbkdf2-sha256$${ITERATIONS}$${b64url(salt)}$${b64url(hash)}`;
}
