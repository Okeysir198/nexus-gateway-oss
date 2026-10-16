# Invariants, architecture and gotchas

The rules that break things quietly. Source comments refer to these by number
("Invariant 4b"). Read this before touching auth, routing, the translate layer or the
console.

## Invariants

### 1. Every request goes through AI Gateway
Enforced in three places, deliberately redundant:
- `dispatch()` returns 500 for any route without `aig.slug`; it will not fall back.
- **There is no direct-fetch code path.** Re-adding a bare `fetch()` to an upstream
  silently reopens the hole and skips AI Gateway's logging, caching and rate limiting.
- `test/router.test.ts` asserts every shipped route has a slug; `validateConfig` warns at
  runtime and surfaces it on `/health`.

`DROP_REQUEST_HEADERS` strips `authorization`, so each egress sets the upstream credential
explicitly (the pooled key, the single secret, or the caller's own key under BYOK).

### 1b. One virtual-key gate, above every backend
`index.ts` runs `authenticate()` ONCE, after the `/admin/*` and master-keyed `/key/*`
branches and before any chat or Anthropic-surface handling. A gate that must be remembered
per route will eventually be forgotten; this one covers any route added below it by
default. Add a new backend below the gate and it is authed by default; add one above it and
you have reopened the hole.

The key must arrive in `Authorization`, `x-api-key`, or `?api_key=` (`extractToken`).

### 4. D1 is the sole key authority
`/key/*` mints, revokes and lists against D1 only.
- **Revocation must hash first.** `revokeKey` matches `key_id` or `token_hash`; passing a
  raw `sk-...` matches neither and silently revokes nothing. `keyDelete` hashes; the console
  sends `key_ids[]`.
- **`raw_json` must never contain a token.** `upsertKey` strips `key`/`token`.
- Timestamps go through `toEpochSeconds`: rows imported from other proxies may hold ISO
  strings in INTEGER columns, which break expiry comparison and list ordering.
- KV is **not** used for auth (eventual consistency); D1 is strongly consistent.
- `auth.ts` keeps a **per-isolate cache in front of D1**: positive 60s (`POS_TTL`),
  negative 10s (`NEG_TTL`). A revoked key can still be served for up to 60s from an
  already-warm isolate; "strongly consistent" is about the *store*, not the observed
  latency. Don't promise instant revocation. A **D1 outage** verdict is deliberately never
  cached: failing closed for 60s on a blip would be worse than the extra query.

### 4b. BYOK: a non-D1 token is a cloud-only credential
A token that misses in D1 is not an automatic 401. On the **chat paths and Anthropic
surfaces only**, `authenticate()` hands it back as `byokToken` and `dispatch` forwards it
upstream as the caller's own provider key (`callCloudViaAIG(..., byok)`, replacing both the
single secret and the pooled key; nothing is rotated or cooled, the quota is theirs). So a
third party can use the edge with their own OpenRouter or OpenAI key and no virtual key.
- `byokToken` is deliberately **absent** for "missing API key" and for a **D1 outage**;
  populating it on the outage path would turn a blip into anonymous upstream calls.
- **Dynamic routes refuse BYOK.** A `dynamic/*` route picks its own provider inside AI
  Gateway, so the caller cannot know which credential the hop needs; `dispatch` answers 401
  and asks for a virtual key.
- Consequence: a *revoked or mistyped* virtual key no longer 401s at the edge. It misses D1,
  gets forwarded as a provider key, and the caller sees the **provider's** 401. That was the
  accepted trade of putting BYOK in the `Authorization` slot rather than a separate header.
  Settle a doubtful key with
  `select token_prefix from virtual_keys where token_hash = <sha256 of the raw token>`.
- Widening the condition that scopes BYOK to chat paths would hand strangers whatever other
  backend you add later. Keep it narrow.

### 6. Two config layers: bundled floor + D1 overlay
`src/config.ts` imports `config.default.json` at build time (the FLOOR; editing it needs a
`wrangler deploy`) and overlays the D1 `providers` / `provider_aliases` tables on top
(runtime, ~60s cache). A D1 row wins.

That ordering is deliberate: a fresh deploy with an empty database still serves, a D1
outage degrades to the bundled set instead of refusing every model, and a row can disable a
bundled provider without a code change. **Not KV**: this gates spend, and KV's eventual
consistency means a provider you just disabled could still be served.

### 7. Prompt-cache breakpoints must survive translation, and usage must not double-count
`cache_control` is a property **of a content BLOCK**. Anything that joins blocks into one
string deletes it, and with it all prompt caching on every translated route, silently,
because the request and response still look valid. There are **three** places that flatten,
and all three must preserve it: `a2o_request.systemToContent`, `a2o_request.convertMessage`,
and `reasoning.normalizeContent` (which runs AFTER the conversion and undoes the first two
if it flattens). Each emits a plain string when no block carries a breakpoint, which is the
overwhelming majority of traffic and the shape every upstream accepts.

Which upstreams need them: Alibaba Qwen and Anthropic on OpenRouter require explicit
breakpoints; OpenAI, Grok, Moonshot, Groq, DeepSeek, Z.AI and Gemini 2.5 cache
automatically and ignore them. Anthropic-native routes never reach the translate layer
(passthrough).

**The two wires disagree about what a prompt token is.**
`usage.prompt_tokens_details.cached_tokens` is a **subset** of `prompt_tokens`; Anthropic's
`cache_read_input_tokens` is **disjoint** from `input_tokens`. So the mapping subtracts
(`openaiToAnthropicUsage`); copying the field across unchanged double-counts every cached
token in any consumer that sums the three, which is what a cost roll-up does. Cache hits
through OpenRouter are **not reliable** (provider routing can land on a cold cache). The
cache fields are emitted **only when the upstream reported `prompt_tokens_details`**: a
route that says nothing about caching is UNKNOWN, not zero.

**Streaming needs two more things.** An OpenAI-wire response carries no usage unless
`stream_options: {include_usage: true}` is sent (`a2o_request` sets it when the caller did
not), and that usage chunk arrives **after** the `finish_reason` chunk, so the terminal
`message_delta` must be deferred to `[DONE]`/flush or `finish()`, being once-only, drops the
counters. Without both, a streamed turn reads as `input_tokens: 0`: "never told", not
"free". Emission stays provider-dependent.

## Architecture

- **`src/index.ts`**: entry and `dispatch()`: auth, resolve route, AI Gateway egress.
- **`src/config.ts`**: bundled route table, `${VAR}` interpolation, `validateConfig`
  (warn-and-drop, never throws on a field error; a hard throw would 500 all traffic).
- **`src/router.ts`**: `splitModel` (split on the FIRST `:` or `/`) plus a prefix map; an
  unknown prefix falls through to `catchAll`.
- **`src/providers_db.ts`**: the D1 overlay behind Invariant 6.
- **`src/upstream/aigateway.ts`**: the single egress. `callViaAIGateway` and
  `callCloudViaAIG` for chat (plus the NVIDIA key rotation, which AI Gateway cannot do),
  `proxyViaAIG` for any-method/any-path/binary.
- **`src/upstream/openai.ts`**: only `pickKey` (pooled round-robin vs single-secret outbound
  auth).
- **`src/keypool.ts`**: the NVIDIA multi-key round-robin with cooldown behind `pickKey`.
- **`src/upstream/anthropic.ts`**: native Anthropic surfaces beyond chat, via the AI Gateway
  `anthropic` provider: root `/v1/messages/count_tokens` and `/v1/messages/batches*`, and
  `/anthropic/v1/*` for an SDK whose base URL is `https://<your-host>/anthropic` (reaches
  files, skills, models and agents; nothing enumerates them). `anthropicSurface()` is the
  security boundary: it denies `/v1/organizations` and `oauth` (your key can reach the
  Admin API; a virtual key must not), checked on the DECODED path. Caller `cf-aig-*` and
  `anthropic-workspace-id` headers are stripped. Files and batches belong to the Anthropic
  ORG, so any virtual key that learns an id can read it; that is accepted. JSON bodies over
  4 MB and multipart bodies stream through unrewritten, so use bare model ids there.
  `wrangler.toml` `[placement] hostname = "api.anthropic.com"` is load-bearing: Anthropic
  403s ("Request not allowed", no `request-id`) requests egressing from unsupported colos.
- **`src/thinking_session_do.ts`**: the `ThinkingSessionDO` class bound in `wrangler.toml`;
  `translate/thinking_session.ts` is its client side.
- **`src/streaming/sse.ts`**: SSE framing shared by the translate layer.
- **`src/{errors,headers,health,types}.ts`**: error shapes, header allow/deny lists,
  `/health` (surfaces `validateConfig` warnings), shared types.
- **`src/translate/`**: `a2o_request`, `o2a_response`, `a2o_stream` (the streaming state
  machine), `reasoning` (dialects), `thinking_session` (DO client).
- **`src/auth.ts`, `keys_db.ts`, `key_webhook.ts`**: D1 virtual keys.
- **`src/admin/`**: `login.ts` (Google sign-in and the session cookie), `google.ts` (OAuth
  helpers), `session.ts` (HMAC sessions), `routes.ts` (API),
  `page.ts`/`view_shell.ts`/`view_{keys,providers,users}.ts`/`ui.ts`/`icons.ts`/`brand.ts`/
  `styles.ts`/`client_core.ts` (server-rendered HTML), `theme/{fonts,app.css.gen}.ts`
  (static and generated; see `docs/console-ui.md`).
- **Bindings:** `KEYS_DB` (D1), `THINKING_SESSION_DO`.

## Console UI rules that bite

Full detail in `docs/console-ui.md`.
- `npm test` runs `check:css` first; a stale `app.css.gen.ts` fails it. Tailwind v4 emits
  nothing for an unresolvable utility, so `check:css` asserts sentinel PRESENCE.
- **No backticks or `${}` in any view, CSS or JS template literal.** `tsc` does not catch
  it; the Worker fails to boot, a total outage.
- Structure is load-bearing: the tab radios, sidebar and `sidebar-inset` must stay wrapper
  siblings or a tab silently never shows (`test/page_render.test.ts` guards it).
- No inline `style=` (a nonce does not cover it); `font-src data:` is required.
- Nonce-based CSP (no `unsafe-inline`), `frame-ancestors 'none'`, `form-action 'none'`; the
  sign-in "button" is a LINK to `/login/google`, never a form POST.

## Auth

**Console (`/admin`)** is Google-only; no key in the browser:
- `GET /login/google` mints a `g_state` nonce cookie (HttpOnly, **SameSite=Lax**, because it
  must survive the top-level redirect back from Google; the SESSION cookie is Strict) and
  303s to Google with scopes `openid email` and `prompt=select_account`. The redirect URI
  is derived from the request's own origin.
- `GET /oauth/google/callback` verifies state, exchanges the code, asks userinfo who it
  was, then checks **`isOperator()` against `OPERATOR_EMAILS`** (trim, case-insensitive).
  An EMPTY list denies everyone: half-configured means unconfigured, and an allowlist that
  silently admits the world is the failure worth preventing.
- Success mints the `nexus_admin` cookie: payload `{ e: email, exp }`, HMAC-SHA256 keyed
  from `ADMIN_SESSION_SECRET`. Stateless by design: verification is signature, expiry,
  email, with no D1 lookup. 12h TTL; HttpOnly; Secure; SameSite=Strict.
- **Rotating `ADMIN_SESSION_SECRET` signs every operator out everywhere**; that is the kill
  switch. Removing an address from `OPERATOR_EMAILS` blocks the NEXT login only.
- No login throttle, on purpose: Google owns credential abuse; there is no password here to
  guess. CSRF: SameSite=Strict plus the `x-nexus-console` header on mutating API routes.
- Operators are managed by editing `OPERATOR_EMAILS` in `wrangler.toml` and deploying. The
  Operators tab is read-only.

**API**: callers use D1 virtual keys, never the master key. `NEXUS_MASTER_KEY` gates
`/key/*`; it is the machine surface and the recovery path if the console locks you out. It
is a Worker secret and cannot be read back, so keep your own copy. Mint everyday keys from
`/admin` > API keys > Generate (operator session, no master key needed).

## Gotchas

- **`wrangler deploy` publishes to production immediately.** If `wrangler.toml` declares a
  `custom_domain` route there is no preview step. `npm run deploy` is an alias.
- **A lockfile regenerated on an arm64 machine is arm64-only.** `npm install` records only
  the optional platform packages it resolved, so an x64 machine running `npm ci` finds the
  tree incomplete (`@emnapi/runtime`/`@emnapi/core` missing) while `npm ci` succeeds
  locally. Regenerate with `npm install --package-lock-only`, then verify with
  `npm ci --dry-run --os=linux --cpu=x64`; afterwards BOTH `@cloudflare/workerd-linux-64`
  and `-arm64` must be in the lock.
- **`@cloudflare/vitest-pool-workers@0.18` has no `./config` subpath.** The
  `defineWorkersConfig` recipe in most docs fails to import; the pool is wired through
  vitest's own `pool` option from the ROOT export (see `vitest.config.ts`).
- **A secret added in the DASHBOARD is not live until you deploy the version it created.**
  Save on *Workers > Settings > Variables and Secrets* uploads a new **version**; the
  release still points at the old one. So `wrangler secret list` shows the secret while
  `env.<NAME>` is empty at runtime and the route 503s `no API key configured for provider
  X`, indistinguishable from a missing or mistyped provider row. Compare
  `wrangler versions list` against `wrangler deployments list` (what serves), then
  `wrangler versions deploy <version-id>`. Allow ~10s afterwards.
- **A Cloudflare API token without D1 scope** works for AI Gateway admin and
  `wrangler secret list`, but every `wrangler d1 execute --remote` fails with `The given
  account is not valid or is not authorized to access this service [code: 7403]`, which
  reads like a wrong database id. Use the dashboard's D1 console or a token with `D1:Edit`.
- **Config edits need a redeploy** (bundled, not KV).
- **`base_url` is a bare host; non-standard paths go in `aig.path`** (for example Z.AI's
  coding and Anthropic-compatible endpoints). AI Gateway appends the URL suffix to a custom
  provider's `base_url`, so a provider's path belongs in the route entry, not the base.
- **Reasoning is trimmed on the Anthropic-to-OpenAI input side.** Prior `thinking` blocks
  are dropped (OpenAI has no input field for them; sending them 400s). `thinking` is also
  stripped for `openai/*` regardless of model. Round-trip across turns is best-effort via
  `ThinkingSessionDO`; the signed signature cannot survive an OpenAI-compat hop. Use a
  native-passthrough route (`zai_anthropic/*`, `anthropic/*`) when you need the signed chain.
- **A new Anthropic request field breaks every OpenAI-compat route until it is
  deny-listed.** `a2o_request.ts` spreads the WHOLE Anthropic body, so an unrecognised
  field is forwarded verbatim; strict upstreams 400 on unknown params rather than ignoring
  them (`Validation: Unsupported parameter(s)`). Add the field to `ANTHROPIC_ONLY_FIELDS`.
  It is deliberately a **deny**-list: an allow-list would swallow intentional passthrough
  extras like `chat_template_kwargs: {enable_thinking: false}`. The symptom is a *dead
  model*, not a bad-request error, because the upstream names the field, never the caller.
- **A Durable Object spins up only when the CLIENT sends `thinking`**; gating on the route
  instead would create a DO for every request to a reasoning-capable provider.
- **Provider reds in tests are usually provider-side**: stale keys, region blocks,
  deprecated endpoints. Every request still reaches its provider.
- **A dynamic route's `fallback` edge is the GENERIC failure edge**, not a 429/5xx one: the
  caller sees the fallback's error, and node `timeout` is first-byte, not total. See
  `docs/dynamic-routes.md`.
- **Verify a provider key against the provider DIRECTLY before blaming AI Gateway.** A stale
  key returns 401/403 from the AI Gateway hop, which reads exactly like a gateway-auth or
  BYOK failure. One `curl` to the provider settles it.
- **Prompt caching and usage** are summarised under Invariant 7; remember that streamed
  usage arrives after `finish_reason`.

## Tests

`npm test` (vitest in workerd, via `@cloudflare/vitest-pool-workers`), so
`TransformStream` and `crypto.subtle` behave as in production; `pretest` runs `check:css`
first. Mostly pure-function (router, translate layer, key pool, BYOK boundary, prompt
caching, Google session gate); `page_render` renders `adminPage()`/`loginPage()` and asserts
the template literals and tab structure survived. `dispatch`, AI Gateway and real D1 are
left to the live suite.

`tests/*.py` is the LIVE suite, gated on `RUN_NEXUS_LIVE=1`; it skips (never errors) when
the edge is unreachable.

tsconfig runs `strict` plus `noUnusedLocals`, `noUnusedParameters`,
`noFallthroughCasesInSwitch` and **`noUncheckedIndexedAccess`**; the last one is why
`arr[i]` is `T | undefined`, so narrow at the point of extraction rather than asserting at
each use.

## Model naming

`{provider}:{model}` or `{provider}/{model}`, split on the FIRST separator, so
`openrouter/deepseek/deepseek-v4` keeps the internal slash and `groq/qwen:7b` treats the
colon as part of the model id. A prefix that is not a known provider (or alias) falls
through to `catchAll` with the WHOLE string preserved.

**`dynamic/{route-name}` is an AI Gateway dynamic route** (conditional routing, per-model
timeouts, cross-model fallback; configured in the AI Gateway dashboard, no deploy). It is
the one prefix that is NOT stripped on the way out: dynamic routes live on AI Gateway's own
`compat` endpoint and are addressed as the literal model `dynamic/{name}`, so the provider
entry sets `keepPrefix: true` and `outboundModel()` (router.ts) returns the whole string.
Send the bare route name instead and AI Gateway answers `Chat completion bad format`.
Callers need a nexus virtual key (BYOK is refused), and it works only while a route's nodes
share ONE provider. Detail: `docs/dynamic-routes.md`.

## Adding a provider

No deploy needed for the common case:

1. Register it in AI Gateway (or use a native slug):
   `POST /accounts/{acc}/ai-gateway/custom-providers` with `{name, slug, base_url, enable}`.
   **`base_url` is the bare host**, and referencing a custom provider REQUIRES the
   `custom-` prefix (registered `myprov`, referenced as `custom-myprov`).
2. `wrangler secret put <PROVIDER_KEY>`. This is the one step that needs a deploy cycle
   until the key lives in AI Gateway itself.
3. `/admin` > **Providers** > add `{prefix, slug, secret}`. Live within ~60s.

Only edit `config.default.json` for a provider that should survive a database reset, or when
you need a quirk the console does not expose.
