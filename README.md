# nexus-gateway

A Cloudflare Worker that puts cloud LLM providers behind one OpenAI- and
Anthropic-compatible API, with per-caller virtual keys and an operator console. Every
request goes out through Cloudflare AI Gateway, so logging, caching, rate limiting and
analytics live in one dashboard.

- **Two wires.** OpenAI `/v1/chat/completions` and Anthropic `/v1/messages`, with a
  translator between them (streaming, tools and reasoning included).
- **Any cloud provider.** A provider is a model prefix mapped to an AI Gateway slug. Add
  one, and its API key, from the console with no deploy.
- **Virtual keys** in D1: mint, revoke and expire keys per caller.
- **BYOK.** A caller may send a provider's own key instead of a virtual key.
- **Anthropic native surfaces** (`count_tokens`, batches, files, ...) pass through
  untouched.
- **Operator console** at `/admin`, in light or dark: API keys, providers and their keys.

[Quick start](#quick-start) · [Call the API](#call-the-api) · [Claude Code](#use-with-claude-code) ·
[Configure](#configure) · [How it works](#how-it-works) · [Development](#development)

## Quick start

You need a Cloudflare account, Node 20+, and a domain on Cloudflare (or use `--workers-dev`).

```bash
npm install
export CLOUDFLARE_API_TOKEN=...                      # how to get it: just below
node scripts/deploy.mjs --domain gateway.example.com
```

The command:

- creates a D1 database with the schema, and an AI Gateway with the custom providers the
  bundled config uses;
- deploys the Worker on your domain and sets its secrets;
- checks the live URL, then prints the console address and a generated password;
- is safe to run again, and never touches a Worker, database or gateway it did not create.

Options:

- `--workers-dev`: serve on a `workers.dev` URL instead of a domain.
- `--name <name>`: Worker name (default `nexus-gateway-oss`).
- `--destroy`: delete exactly what the script created.
- `--account-id`, `--yes`: see `node scripts/deploy.mjs --help`.

Get your `CLOUDFLARE_API_TOKEN`:

1. Open <https://dash.cloudflare.com/profile/api-tokens> and click **Create Token**.
2. Next to **Create Custom Token**, click **Get started**.
3. Name it (for example `nexus-gateway deploy`) and add these permissions, one row each:

   | Scope | Permission | Access |
   |---|---|---|
   | Account | Workers Scripts | Edit |
   | Account | D1 | Edit |
   | Account | AI Gateway | Edit |
   | Zone | Workers Routes | Edit |
   | Zone | DNS | Edit |
   | Zone | Zone | Read |

4. Under **Account Resources**, choose **Include > your account**. Under **Zone Resources**,
   choose **Include > Specific zone > your domain**.
5. Click **Continue to summary**, then **Create Token**, and copy the token. It is shown once.
6. Run `export CLOUDFLARE_API_TOKEN=<the token>` in the terminal where you run the script.

Notes:

- Using `--workers-dev` (no domain)? Skip the three Zone rows and the zone resource.
- The token is only read by your terminal; the script never stores it or sends it to the Worker.
- If a call is refused, the script stops and names the missing permission. Add it to the
  token (**Edit** on the token page) and run the script again.

Local state:

- `.deploy/` (gitignored) holds the generated wrangler config, a record of what was created,
  and the master key and console password (mode 600; Worker secrets cannot be read back).
- Back it up, or you will need to rotate the secrets.
- To set everything up by hand instead, see [`docs/manual-setup.md`](docs/manual-setup.md).

### First steps

Open `https://<your-host>/admin` and sign in with the printed password.

1. **Providers:** paste the API key on each provider's row. Its status changes from *Needs key* to *Ready*.
2. **API keys > Generate:** mint a key for your callers. The raw token is shown once.

## Call the API

Point any OpenAI or Anthropic client at `https://<your-host>` with a virtual key:

```bash
curl https://<your-host>/v1/chat/completions \
  -H "Authorization: Bearer <virtual key>" -H 'content-type: application/json' \
  -d '{"model":"openrouter/deepseek/deepseek-v4","messages":[{"role":"user","content":"hi"}]}'
```

| Path | Notes |
|---|---|
| `POST /v1/chat/completions`, `/v1/completions` | OpenAI wire |
| `POST /v1/messages` | Anthropic wire (translated, or native passthrough) |
| `POST /v1/messages/count_tokens`, `/v1/messages/batches*` | native Anthropic |
| `/anthropic/v1/*` | native Anthropic, for an SDK whose base URL is `https://<your-host>/anthropic` |
| `GET /v1/models` | advertised model prefixes (no key) |
| `GET /health` (`?probe=1`) | route table, config warnings, per-provider up/down (no key) |

### Models

- Address a model as **`{provider}:{model}`** or **`{provider}/{model}`**.
- The prefix is split at the first separator and looked up in the provider registry; the rest
  is the model id sent upstream.
- The registry is also the allowlist: an unregistered prefix cannot be reached.

```
nvidia_nim:meta/llama-3.1-8b    -> provider nvidia_nim, model "meta/llama-3.1-8b"
openrouter/deepseek/deepseek-v4 -> provider openrouter, model "deepseek/deepseek-v4"
meta/llama-3.1-8b-instruct      -> unknown prefix -> catch-all, whole string preserved
```

| Prefix | Goes to |
|---|---|
| `nvidia_nim/*` | NVIDIA NIM (multi-key rotation) |
| `openrouter/*`, `groq/*`, `openai/*` | those providers |
| `huggingface/*`, `hf/*` | Hugging Face |
| `cloudflare/*`, `cf/*` | Workers AI |
| `zai/*` | Z.AI GLM (coding endpoint) |
| `zai_anthropic/*`, `anthropic/*` | Anthropic-native: **no translation**, signed thinking survives |
| `dynamic/{route}` | an AI Gateway dynamic route ([`docs/dynamic-routes.md`](docs/dynamic-routes.md)) |
| anything else | NVIDIA NIM (catch-all, whole model string) |

- The bundled table in `src/config.default.json` is the floor; rows added in the console
  override it.

### Virtual keys and BYOK

Mint virtual keys in the console, or with the machine endpoint:

```bash
curl -X POST https://<your-host>/key/generate \
  -H "Authorization: Bearer $NEXUS_MASTER_KEY" -H 'content-type: application/json' \
  -d '{"key_alias":"mobile-app","duration":"30d","max_budget":25}'
```

- The raw token is returned **once**; only its SHA-256 is stored.
- Revoke from the console or with `POST /key/delete` (`{"keys":["sk-..."]}` or
  `{"key_ids":["key-..."]}`); it takes effect within about 60 seconds (the isolate auth cache).

**BYOK:**

- A caller may send a *provider's own* key in the same `Authorization: Bearer` slot.
- It misses in D1 and is forwarded upstream as the caller's credential (their quota; NVIDIA
  key rotation does not apply).
- `dynamic/*` routes refuse BYOK.
- A **revoked or mistyped virtual key** is not rejected at the edge: it goes upstream and you
  get the provider's `401`.

## Use with Claude Code

Run Claude Code on any model from any provider you added a key for.

- `claude` stays native (your normal login).
- `claude-gw` runs the same Claude Code on the gateway.
- Nothing is written to `settings.json`.

Why use it:

- **Any model:** set a default with `GATEWAY_MODEL`, or pick one per run with `claude-gw --model <provider/model>`.
- **Lower cost:** give background tasks a cheaper model with `GATEWAY_SMALL_MODEL`.
- **Shared access:** a team uses one provider key behind per-person virtual keys, each revocable.
- **Visibility:** AI Gateway logs and caches every call.

Limits:

- **`claude-gw` skips permission prompts by default** (`--dangerously-skip-permissions`):
  the model can run shell commands and edit files without asking. Use it in a project you
  trust or a sandbox, or set `GATEWAY_SKIP_PERMISSIONS=0` to be asked first.
- The model must support tool calling.
- Quality varies by model: Claude Code's prompts are tuned for Claude, so smaller models may struggle with agentic tasks.
- Signed thinking survives only on `anthropic/*` and `zai_anthropic/*` ([Limitations](#limitations)).

**1. Save the gateway details once** in `~/.config/nexus-gateway.env`
(`chmod 600` it; the key is a virtual key from **API keys > Generate**):

```bash
GATEWAY_URL=https://<your-host>
GATEWAY_KEY=<your virtual key>
GATEWAY_MODEL=nvidia_nim/nvidia/nemotron-3-super-120b-a12b   # provider/model, see Models
# GATEWAY_SMALL_MODEL=groq/llama-3.1-8b-instant   # optional: cheaper model for background tasks
# GATEWAY_SKIP_PERMISSIONS=0                      # optional: 0 = ask before tools run (default: skip)
```

**2. Add the function** to `~/.bashrc` or `~/.zshrc`, then open a new terminal:

```bash
claude-gw() {
  local cfg="${NEXUS_GATEWAY_ENV:-$HOME/.config/nexus-gateway.env}"
  [ -r "$cfg" ] || { echo "claude-gw: create $cfg (see the README)" >&2; return 1; }
  local pick=""                                   # claude-gw --model <provider/model> ...
  case "$1" in
    --model)   pick="$2"; shift 2 ;;
    --model=*) pick="${1#--model=}"; shift ;;
  esac
  ( . "$cfg"
    local model="${pick:-${GW_MODEL:-$GATEWAY_MODEL}}"
    local skip=--dangerously-skip-permissions
    [ "${GATEWAY_SKIP_PERMISSIONS:-1}" = 0 ] && skip=
    env -u ANTHROPIC_API_KEY \
      ANTHROPIC_BASE_URL="$GATEWAY_URL" \
      ANTHROPIC_AUTH_TOKEN="$GATEWAY_KEY" \
      ANTHROPIC_MODEL="$model" \
      ANTHROPIC_DEFAULT_SONNET_MODEL="$model" \
      ANTHROPIC_DEFAULT_OPUS_MODEL="$model" \
      ANTHROPIC_DEFAULT_HAIKU_MODEL="${GATEWAY_SMALL_MODEL:-$model}" \
      claude $skip "$@" )
}
```

**3. Use whichever you want:**

```bash
claude                                                                   # native Anthropic, unchanged
claude-gw                                                                # the gateway, with GATEWAY_MODEL
claude-gw --model nvidia_nim/nvidia/nemotron-3-super-120b-a12b           # pick the model for this run
claude-gw -p "cat hello.py"                                              # one prompt, then exit
claude-gw --model nvidia_nim/nvidia/nemotron-3-super-120b-a12b -p "hi"   # model and prompt together
claude-gw --resume                                                       # any other claude flag works
```

Notes:

- The variables exist only for that one command, so nothing leaks into your normal `claude`.
- Do not put `ANTHROPIC_BASE_URL` in `settings.json`: it would send every run to the gateway.
- **Set all three model tiers.** Claude Code uses a small model for background tasks; a tier
  left unset sends Anthropic's own model name, which most providers reject.
- **Anthropic models** (`anthropic/*`, `zai_anthropic/*`) pass through untouched, so extended
  thinking and prompt caching work as with Anthropic. Other providers are translated.
- **Token counting** (`/v1/messages/count_tokens`) is forwarded to Anthropic, so it needs an
  Anthropic key.
- **One virtual key per person or project**, so you can revoke one without touching the rest.
  A provider's own key also works as `GATEWAY_KEY` ([BYOK](#virtual-keys-and-byok)).

## Configure

### Console sign-in

`deploy.mjs` sets a shared password. Keep it, add Google, or use both; with neither
configured `/admin` cannot be entered.

- **Shared password:** the `ADMIN_PASSWORD_HASH` secret. Anyone who knows it gets in.
- **Google:** `GOOGLE_CLIENT_ID` and `OPERATOR_EMAILS` in `wrangler.toml`, plus the
  `GOOGLE_CLIENT_SECRET` secret. Only addresses in `OPERATOR_EMAILS` get in; an empty list
  denies everyone.
- Rotating `ADMIN_SESSION_SECRET` signs every operator out.
- Details: [`docs/manual-setup.md`](docs/manual-setup.md#console-sign-in) and
  [`docs/console-google-signin-runbook.md`](docs/console-google-signin-runbook.md).

### Provider keys

The **Providers** tab lists each provider with a status (*Ready* or *Needs key*) and a key field.

- Paste a key and Save; it is live within about a minute, with no deploy.
- A saved key shows only its last four characters, with *Replace* and *Remove*.
- A key set with `wrangler secret put` shows as *Set in wrangler*.
- A provider with several keys (NVIDIA rotates across up to six) has a *Manage keys* button.
- Keys are stored in D1, AES-GCM encrypted. The encryption key derives from
  `NEXUS_MASTER_KEY`, or from `KEY_ENCRYPTION_SECRET` if set. **If that value changes, stored
  keys become unreadable and show as missing; enter them again.**
- A key set with `wrangler secret put` always wins over one entered in the console.
- Only secret names a provider already references can be stored, so this cannot overwrite
  `NEXUS_MASTER_KEY` or any other setting.
- Anyone who can sign in to the console can replace or remove provider keys.

### Adding a provider

No deploy is needed; the registry lives in D1. **Providers > Add provider** covers it all:

- **Native provider** (`groq`, `openai`, `openrouter`, `huggingface`, `anthropic`,
  `workers-ai`): enter the prefix, the slug (its bare name) and the API key.
- **Any other provider:** enter the prefix, its **Base URL** (for example
  `https://api.myprov.com`) and the API key. The gateway registers it in AI Gateway as
  `custom-<prefix>` and saves it. An existing provider with the same URL is reused; one with a
  different URL is refused, never repointed.

The Base URL field appears when the Worker has an `AIG_API_TOKEN` secret: a **separate**
Cloudflare API token with only *AI Gateway: Edit* on your account (not the deploy token).

```bash
export AIG_API_TOKEN=...                           # before node scripts/deploy.mjs, or
npx wrangler secret put AIG_API_TOKEN              # on an existing deployment
```

Without it, register the provider by hand first and enter its slug (`custom-myprov`) in the form:

```bash
curl -X POST "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/ai-gateway/custom-providers" \
  -H "Authorization: Bearer $CF_API_TOKEN" -H 'content-type: application/json' \
  -d '{"name":"My Provider","slug":"myprov","base_url":"https://api.myprov.com","enable":true}'
```

- A custom AI Gateway provider is referenced with the `custom-` prefix; native providers use
  their bare name.
- A non-standard endpoint path goes in the route's `path`.

## How it works

Every request passes the gate once, is routed by its model prefix, and leaves only through
AI Gateway.

```
  client   OpenAI or Anthropic request
      │
      ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 1  GATE      who is calling?                                           │
│                                                                        │
│   virtual key ....... ok     key sent upstream: Worker secret or pool  │
│   unknown key ....... BYOK   key sent upstream: the caller's own       │
│   no key / D1 down .. 401    never falls back to BYOK                  │
└────────────────────────────────────────────────────────────────────────┘
      │  chat requests
      ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 2  ROUTE     which provider?                                           │
│                                                                        │
│   split the model at the first ":" or "/"                              │
│   unknown prefix ... catch-all (NVIDIA NIM)                            │
│   dynamic/* + BYOK . 401                                               │
└────────────────────────────────────────────────────────────────────────┘
      │  provider + model
      ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 3  SHAPE     which wire does the provider speak?                       │
│                                                                        │
│   Anthropic-native (anthropic, zai_anthropic) .. sent as is            │
│   OpenAI provider, OpenAI request .............. reasoning dialect     │
│   OpenAI provider, Anthropic request ........... translated both ways; │
│                                                  thinking text kept by │
│                                                  ThinkingSessionDO     │
└────────────────────────────────────────────────────────────────────────┘
      │
      ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 4  EGRESS    Cloudflare AI Gateway: the only way out                   │
│                                                                        │
│   native slugs ... groq, openai, openrouter, huggingface,              │
│                    anthropic, workers-ai                               │
│   custom slugs ... custom-nvidia, custom-zai, custom-zai-anthropic     │
└────────────────────────────────────────────────────────────────────────┘
      │
      ▼
  provider response, streamed back in the caller's wire
```

- **Anthropic extras skip steps 2 and 3.** `count_tokens`, `batches*` and `/anthropic/v1/*`
  pass the gate, then go straight to AI Gateway untouched. `/v1/organizations` and `oauth`
  are refused with 403.
- **Auth:** the token comes from `Authorization`, `x-api-key` or `?api_key=`, and is looked up
  in D1 by SHA-256 (isolate cache: hit 60 s, miss 10 s). Code: `src/auth.ts`.
- **A provider with no AI Gateway slug** is a 500; nothing is ever fetched directly.

## Limitations

- **rpm, tpm and budget are recorded on a key but not enforced at the edge.**
- **Signed Anthropic thinking cannot round-trip** through an OpenAI-compatible upstream. Text
  is re-injected best-effort via a Durable Object; use `zai_anthropic/*` or `anthropic/*`
  when you need the signed chain intact.
- **Console sessions are stateless.** Removing an operator from `OPERATOR_EMAILS` blocks the
  next login only; existing cookies run out at the 12-hour TTL.
- **A revoked key can be served for up to 60 seconds** from a warm isolate.

## Development

```bash
npm run check:css && npm run typecheck && npx vitest run   # the whole gate
npx wrangler dev                                           # local (copy .dev.vars.example to .dev.vars)
npx wrangler tail                                          # live logs
```

- The unit tests in `test/` run inside workerd. There is no CI.
- Contributing: [`CONTRIBUTING.md`](.github/CONTRIBUTING.md).
- [`docs/invariants.md`](docs/invariants.md): rules that break things quietly
- [`docs/console-ui.md`](docs/console-ui.md): the console's CSS pipeline, page structure and routes
- [`docs/dynamic-routes.md`](docs/dynamic-routes.md): AI Gateway dynamic routes
- [`docs/manual-setup.md`](docs/manual-setup.md): step-by-step setup and sign-in options

## Security and license

Report vulnerabilities privately; see [`SECURITY.md`](.github/SECURITY.md). Licensed under
[MIT](LICENSE); the vendored Geist fonts are under the SIL Open Font License (see
[`NOTICE`](NOTICE)).
