# Manual setup

`node scripts/deploy.mjs` does all of this for you (see the README). Use these steps if you
would rather run each one yourself, or want Google sign-in from the start.

1. **Install.** `npm install`
2. **Create an AI Gateway** in the Cloudflare dashboard (AI > AI Gateway). Its name is your
   `AIG_GATEWAY_ID`; your account id is `CF_ACCOUNT_ID`. Leave gateway authentication off:
   the Worker sends no `cf-aig-authorization` header.
3. **Create the key database and fill in `wrangler.toml`.**
   ```bash
   npx wrangler d1 create nexus_keys        # prints a database_id
   ```
   Paste that `database_id`, your `CF_ACCOUNT_ID` and `AIG_GATEWAY_ID` into `wrangler.toml`.
   Optionally uncomment `routes` and set your hostname (`custom_domain = true`); without a
   route the Worker answers on its `workers.dev` URL. Then load the schema:
   ```bash
   npx wrangler d1 execute nexus_keys --remote --file=schema.sql
   ```
4. **Register the custom providers** the bundled config uses
   ([below](#ai-gateway-custom-providers)). Native providers (`groq`, `openai`,
   `openrouter`, `huggingface`, `anthropic`, `workers-ai`) need nothing.
5. **Set the secrets.** Provider API keys are not among them; you add those in the console.
   ```bash
   npx wrangler secret put NEXUS_MASTER_KEY          # openssl rand -base64 32
   npx wrangler secret put ADMIN_SESSION_SECRET      # openssl rand -base64 32
   node scripts/hash-password.mjs | npx wrangler secret put ADMIN_PASSWORD_HASH
   ```
   The last line sets the console password (prompted, hidden). Skip it if you use Google.
6. **Deploy.** `npx wrangler deploy` publishes immediately; there is no preview step.
7. **Add your provider keys and mint a caller key** in the console (README, "First steps").

## Console sign-in

Configure at least one; with neither, `/admin` cannot be entered.

| Method | Setup | Who gets in |
|---|---|---|
| Shared password | `ADMIN_PASSWORD_HASH` secret (step 5) | anyone who knows the password |
| Google | `GOOGLE_CLIENT_ID` and `OPERATOR_EMAILS` in `wrangler.toml`, `GOOGLE_CLIENT_SECRET` secret | only the addresses in `OPERATOR_EMAILS`; an empty list denies everyone |

- With both set, the sign-in page shows both. With only the password, the Google button is
  hidden.
- Google needs an OAuth client (type *Web application*) with
  `https://<your-host>/oauth/google/callback` as an authorised redirect URI. The Worker
  derives that URI from the request origin, so no host is hardcoded. See
  [`console-google-signin-runbook.md`](console-google-signin-runbook.md).
- The password is stored only as a PBKDF2 hash (12 characters minimum; a long random one is
  best), and it does not consult `OPERATOR_EMAILS`. Its sessions appear as `shared-password`.
  Failed attempts are throttled per Worker isolate only, so if the console is public add a
  Cloudflare rate-limiting rule on `POST /login/password`.
- Rotating `ADMIN_SESSION_SECRET` signs every operator out. To change the password, make a
  new hash and rotate the session secret to end existing sessions.

## AI Gateway custom providers

The bundled config uses three custom providers. Registering them takes a Cloudflare API
token with AI Gateway edit permission (`$CF_API_TOKEN`). Register each with a **bare-host**
`base_url` (API paths live in the route entry) and reference it with the `custom-` prefix:

| Registered slug | Referenced as | `base_url` |
|---|---|---|
| `nvidia` | `custom-nvidia` | `https://integrate.api.nvidia.com` |
| `zai` | `custom-zai` | `https://api.z.ai` |
| `zai-anthropic` | `custom-zai-anthropic` | `https://api.z.ai` |

```bash
curl -X POST "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/ai-gateway/custom-providers" \
  -H "Authorization: Bearer $CF_API_TOKEN" -H 'content-type: application/json' \
  -d '{"name":"NVIDIA","slug":"nvidia","base_url":"https://integrate.api.nvidia.com","enable":true}'
```

Only register the ones you use, and delete the rest from `src/config.default.json` so
`/health` stays free of warnings.
