# Runbook - Google sign-in for the operator console

Google sign-in is optional: the console also accepts a shared password (see `manual-setup.md`,
"Console sign-in"). Do this only if you want Google, when standing the console up on a fresh
account, or when rotating the OAuth client.

1. Google Cloud Console: create (or reuse) an OAuth client of type *Web application*.
   Add `https://<your-host>/oauth/google/callback` to its authorised redirect URIs. The
   Worker derives the redirect URI from the request's own origin, so every hostname you
   serve the console from (a custom domain, a `workers.dev` URL) needs its own entry.
   If the client is shared with other apps, **append** to the list; replacing it breaks
   those apps with `redirect_uri_mismatch` at Google's consent page, before this Worker is
   reached.
2. Put the client id in `wrangler.toml` as `GOOGLE_CLIENT_ID` and your allowed operator
   emails in `OPERATOR_EMAILS` (comma-separated; an empty list denies every Google account).
3. `npx wrangler secret put GOOGLE_CLIENT_SECRET`
4. `npx wrangler secret put ADMIN_SESSION_SECRET` with a fresh 32-byte random value
   (`openssl rand -base64 32`). Rotating it later signs every operator out.
5. `npx wrangler deploy`
6. Smoke test: open `https://<your-host>/admin`, sign in with Google; the console loads and
   `/admin/whoami` returns your email.

Notes:
- A Cloudflare API token needs `D1:Edit` for `wrangler d1 execute --remote`; a token
  without it fails with code 7403, which reads like a wrong database id.
- Removing an address from `OPERATOR_EMAILS` blocks the next login only; outstanding
  cookies run out at the 12h TTL.
