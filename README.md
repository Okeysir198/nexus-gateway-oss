# nexus-gateway

A Cloudflare Worker that puts cloud LLM providers behind one OpenAI- and
Anthropic-compatible API with per-caller virtual keys. Every request egresses through
Cloudflare AI Gateway, so you get uniform logging, caching, rate limiting and analytics in
one dashboard.

Rules that break things quietly are in [`docs/invariants.md`](docs/invariants.md).

## What it does

- **Two wires.** OpenAI `/v1/chat/completions` and native Anthropic `/v1/messages`, with a
  hand-rolled translator between them (streaming, tools and reasoning included).
- **Any cloud provider.** Each is a route mapping a model prefix to an AI Gateway provider
  slug. Add one from the console with no deploy.
- **Everything through AI Gateway.** There is no direct-fetch path to a provider.
- **Virtual keys** in D1: mint, revoke, expire, per caller.
- **BYOK.** A caller may send a cloud provider's own key instead of a virtual key.
- **Anthropic native surfaces** (`count_tokens`, batches, files and the rest of the
  Anthropic API) forwarded through the AI Gateway `anthropic` provider.
- **Operator console** at `/admin` with Google-only sign-in (an `OPERATOR_EMAILS`
  allowlist, fail-closed): API keys, providers and the operator list, in light or dark.

## Endpoints

| Path | Auth | Notes |
|---|---|---|
| `POST /v1/chat/completions`, `/v1/completions` | virtual key **or BYOK¹** | OpenAI wire |
| `POST /v1/messages` | virtual key **or BYOK¹** | Anthropic wire (translated, or native passthrough) |
| `POST /v1/messages/count_tokens`, `/v1/messages/batches*` | virtual key **or BYOK¹** | native Anthropic |
| `/anthropic/v1/*` | virtual key **or BYOK¹** | native Anthropic, for an SDK whose base URL is `https://<your-host>/anthropic` |
| `GET /v1/models` | none | advertised model prefixes |
| `GET /health` (`?probe=1`) | none | route table, config warnings, per-provider up/down |
| `GET /admin` | session | operator console (sign-in page when signed out) |
| `GET /login/google`, `GET /oauth/google/callback` | none | Google sign-in handshake |
| `POST /admin/logout` | none | clears the session cookie |
| `GET /admin/whoami`, `GET /admin/api/users` | session | signed-in email; the operator allowlist (read-only) |
| `GET/POST /admin/api/keys`, `POST /admin/api/keys/revoke` | session | console key operations |
| `GET/POST /admin/api/providers`, `DELETE /admin/api/providers/:name` | session | provider registry |
| `POST /key/generate`, `/key/delete`, `GET /key/list` | master key | machine surface and recovery |

¹ **BYOK**: on these paths you may send a *cloud provider's own* key instead of a nexus
virtual key, in the same `Authorization: Bearer` slot. The token misses in D1 and is
forwarded upstream as your credential (your quota, your rate limit; the NVIDIA key
rotation does not apply). No virtual key is needed:

```bash
curl https://<your-host>/v1/chat/completions \
  -H "Authorization: Bearer <your-openrouter-key>" \
  -H 'content-type: application/json' \
  -d '{"model":"openrouter/deepseek/deepseek-v4","messages":[{"role":"user","content":"hi"}]}'
```

`dynamic/*` routes refuse BYOK. Because BYOK shares the `Authorization` slot, a **revoked or
mistyped virtual key** is no longer rejected at the edge: it goes upstream and you get the
provider's `401`.

## Request flow

```
client
  |  Authorization: Bearer sk-...          (virtual key)
  v
Worker  |- authenticate -> D1 (SHA-256 hash lookup, 60s isolate cache)
        |- resolveRoute(model) -> route entry            src/router.ts
        |- translate if the wire differs from upstream   src/translate/
        '- egress, ALWAYS, to Cloudflare AI Gateway (your gateway)
                                   |
                                   |- native slug:  groq, openai, openrouter,
                                   |                huggingface, anthropic, workers-ai
                                   '- custom slug:  custom-nvidia (key rotation),
                                                    custom-zai, custom-zai-anthropic
```

## Routing

Address a model as **`{provider}:{model}`** (or `{provider}/{model}`). The prefix is split
at the FIRST separator and looked up in the provider registry; everything after it is the
model id sent upstream.

```
nim_nvidia:meta/llama-3.1-8b    -> provider nim_nvidia, model "meta/llama-3.1-8b"
openrouter/deepseek/deepseek-v4 -> provider openrouter, model "deepseek/deepseek-v4"
meta/llama-3.1-8b-instruct      -> unknown prefix -> catch-all, whole string preserved
```

The registry is **also the allowlist**: a prefix that is not registered cannot be reached,
which stops a virtual key spending against a provider nobody enabled.

| Prefix | Goes to |
|---|---|
| `nvidia_nim/*`, `nim_nvidia/*` | NVIDIA NIM (multi-key rotation) |
| `openrouter/*`, `groq/*`, `openai/*` | those providers |
| `huggingface/*`, `hf/*` | Hugging Face |
| `zai/*` | Z.AI GLM (coding endpoint) |
| `zai_anthropic/*` | Z.AI Anthropic-native: **no translation**, signed thinking survives |
| `anthropic/*` | Anthropic API, native: no translation, signed thinking survives |
| `cloudflare/*`, `cf/*` | Workers AI |
| `dynamic/{route}` | an AI Gateway dynamic route ([`docs/dynamic-routes.md`](docs/dynamic-routes.md)) |
| `*` | NVIDIA NIM (catch-all, whole model string) |

Aliases let callers migrate at their own pace: `nim_nvidia` is `nvidia_nim`, `hf` is
`huggingface`, `cf` is `cloudflare`. Edit the bundled table in `config.default.json`; it
is the floor, and rows in D1 override it (see Adding a provider).

## Quick start (your own domain)

Prerequisites: a Cloudflare account, Node 20+, and a Google Cloud project for console
sign-in.

1. **Install.**
   ```bash
   npm install
   cp .dev.vars.example .dev.vars     # local dev secrets
   ```
2. **Create the key database.**
   ```bash
   npx wrangler d1 create nexus_keys                              # prints a database_id
   npx wrangler d1 execute nexus_keys --remote --file=schema.sql
   ```
3. **Create an AI Gateway** in the Cloudflare dashboard (AI > AI Gateway). Note its name:
   that is `AIG_GATEWAY_ID`. The Worker sends no `cf-aig-authorization` header, so leave
   gateway authentication off.
4. **Register the custom AI Gateway providers** the bundled config references (below).
   Native providers (`groq`, `openai`, `openrouter`, `huggingface`, `anthropic`,
   `workers-ai`) need no registration.
5. **Edit `wrangler.toml`:** paste the D1 `database_id`, optionally uncomment `routes` and
   set your hostname (`custom_domain = true`), and set `OPERATOR_EMAILS` and
   `GOOGLE_CLIENT_ID`. Without a route the Worker answers on its `workers.dev` URL.
6. **Google OAuth.** In Google Cloud Console create an OAuth client (type *Web
   application*) and add `https://<your-host>/oauth/google/callback` to its authorised
   redirect URIs. The Worker derives the redirect URI from the request origin, so no host
   is hardcoded; see [`docs/console-google-signin-runbook.md`](docs/console-google-signin-runbook.md).
7. **Set secrets.**
   ```bash
   npx wrangler secret put NEXUS_MASTER_KEY
   npx wrangler secret put CF_ACCOUNT_ID
   npx wrangler secret put AIG_GATEWAY_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   npx wrangler secret put ADMIN_SESSION_SECRET      # openssl rand -base64 32
   npx wrangler secret put NVIDIA_API_KEY            # plus whichever providers you use
   ```
8. **Deploy.** `npx wrangler deploy` publishes immediately; there is no preview step.
9. **Mint a key.** Open `https://<your-host>/admin`, sign in with Google, and use
   **API keys > Generate**. The raw token is shown once; only its SHA-256 is stored.

Console operators are the `OPERATOR_EMAILS` var in `wrangler.toml` (comma-separated, **an
empty list denies everyone**). Rotating `ADMIN_SESSION_SECRET` signs every operator out.

### AI Gateway custom providers

The bundled config uses three custom providers. Register each with a **bare-host**
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

Only register the ones you will use; remove the rest of the entries from
`config.default.json` so `/health` stays free of warnings.

## Keys

```bash
curl -X POST https://<your-host>/key/generate \
  -H "Authorization: Bearer $NEXUS_MASTER_KEY" -H 'content-type: application/json' \
  -d '{"key_alias":"mobile-app","duration":"30d","max_budget":25}'
```

The raw token is returned **once**. Revoke with `POST /key/delete` (`{"keys":["sk-..."]}`
or `{"key_ids":["key-..."]}`), or from the console. Revocation takes effect within ~60s
(the isolate auth cache).

## Adding a provider

**No deploy needed** for the common case; the registry lives in D1:

```bash
# 1. Register it in AI Gateway. base_url is the BARE HOST.
curl -X POST "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/ai-gateway/custom-providers" \
  -H "Authorization: Bearer $CF_API_TOKEN" -H 'content-type: application/json' \
  -d '{"name":"My Provider","slug":"myprov","base_url":"https://api.myprov.com","enable":true}'

# 2. Provide its key (the one step that needs a deploy cycle)
npx wrangler secret put MYPROV_API_KEY

# 3. Add it in the console: /admin > Providers > {prefix: myprov,
#    slug: custom-myprov, secret: MYPROV_API_KEY}.  Live within ~60s.
```

Referencing a **custom** AI Gateway provider requires the `custom-` prefix: the registered
slug is `myprov`, the slug you enter is `custom-myprov`. Native providers use their bare
name.

Non-standard endpoint path? Put it in the route's `path`. AI Gateway appends the path to
the provider's `base_url`.

## Development

```bash
npm run check:css && npm run typecheck && npx vitest run   # the whole gate
npx wrangler dev                                           # local
npx wrangler tail                                          # live logs
```

Unit tests (`test/`) cover the router, SSE codec, reasoning dialects, the translate layer,
prompt caching, the BYOK boundary, the key pool and the console pages. Live smoke tests
(`tests/`, Python) run against a deployed or `wrangler dev` edge and are gated on
`RUN_NEXUS_LIVE=1`. The project ships no CI; see [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Limitations

- **rpm / tpm / budget are recorded on a key but not enforced at the edge.** The columns
  exist; nothing reads them on the request path yet.
- **Signed Anthropic thinking cannot round-trip** through an OpenAI-compat upstream. Text
  is re-injected best-effort via a Durable Object; use `zai_anthropic/*` or `anthropic/*`
  when you need the signed chain intact.
- **Console sessions are stateless.** Removing an operator from `OPERATOR_EMAILS` blocks
  the next login only; outstanding cookies run out at the 12h TTL. Rotate
  `ADMIN_SESSION_SECRET` to sign everyone out at once.
- **A revoked key can be served for up to 60s** from a warm isolate.

## Security

Report vulnerabilities privately; see [`SECURITY.md`](SECURITY.md).

## License

[MIT](LICENSE). The vendored Geist fonts are under the SIL Open Font License; see
[`NOTICE`](NOTICE).
