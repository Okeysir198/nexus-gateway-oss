# Security policy

nexus-gateway authenticates callers, forwards provider credentials and proxies traffic, so
vulnerability reports are welcome.

## Reporting

Please report privately. Use GitHub's "Report a vulnerability" (Security tab, then
Advisories) on this repository. Do not open a public issue for a vulnerability.

Include the affected route or file, a minimal reproduction, and the impact you expect. You
should get an acknowledgement within a few days.

## Scope

In scope: authentication and virtual-key handling (`src/auth.ts`, `src/keys_db.ts`), the
BYOK boundary, the operator console and its session handling (`src/admin/`), the Anthropic
passthrough allow/deny list (`src/upstream/anthropic.ts`), and header or secret leakage in
any upstream path.

Out of scope: findings that require a malicious operator already listed in
`OPERATOR_EMAILS`, and misconfiguration of your own deployment (for example an empty or
leaked `NEXUS_MASTER_KEY`).

## Hardening notes for operators

- Keep `NEXUS_MASTER_KEY`, `ADMIN_SESSION_SECRET` and `ADMIN_PASSWORD_HASH` in
  `wrangler secret`, never in `wrangler.toml` or a committed `.dev.vars`. Provider keys go in
  the console (below) or `wrangler secret`.
- Provider keys entered in the console are encrypted in D1 with a key derived from
  `NEXUS_MASTER_KEY` (or `KEY_ENCRYPTION_SECRET`). Whoever can sign in to the console can
  replace or remove them, though never read them back. Keep the operator list small.
- A revoked virtual key can still be served for up to 60 seconds from a warm isolate.
- A token that misses in D1 on a chat route is forwarded upstream as the caller's own
  provider key (BYOK). A mistyped virtual key therefore surfaces as the provider's 401.
- The optional shared console password (`ADMIN_PASSWORD_HASH`) admits anyone who knows it
  and bypasses `OPERATOR_EMAILS`. Use a long random one and add a Cloudflare rate-limiting
  rule on `POST /login/password`; the built-in throttle is per isolate only.
- Removing an address from `OPERATOR_EMAILS` blocks the next login only; rotate
  `ADMIN_SESSION_SECRET` to end every console session at once.
