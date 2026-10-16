import type { ThinkingSessionDO } from "./thinking_session_do";

/**
 * Worker bindings, vars and secrets (see .dev.vars.example). Provider keys are looked up
 * dynamically by the name in each provider's `secret` field; they may come from a Worker
 * secret or from the console (src/provider_keys.ts).
 */
export interface Env {
  KEYS_DB: D1Database;
  THINKING_SESSION_DO: DurableObjectNamespace<ThinkingSessionDO>;

  /** AI Gateway egress. The Worker calls
   *  `gateway.ai.cloudflare.com/v1/{CF_ACCOUNT_ID}/{AIG_GATEWAY_ID}/{slug}/...`. */
  CF_ACCOUNT_ID: string;
  AIG_GATEWAY_ID: string;

  // admin
  /** The gateway's admin key: authenticates /key/* and the master fast-path, and encrypts
   *  console-stored provider keys unless KEY_ENCRYPTION_SECRET is set. */
  NEXUS_MASTER_KEY: string;

  // NVIDIA 6-key pool (any subset may be set)
  NVIDIA_API_KEY: string;
  NVIDIA_API_KEY_02: string;
  NVIDIA_API_KEY_03: string;
  NVIDIA_API_KEY_04: string;
  NVIDIA_API_KEY_05: string;
  NVIDIA_API_KEY_06: string;

  // cloud providers
  OPENROUTER_API_KEY: string;
  GROQ_API_KEY: string;
  HF_TOKEN: string;
  OPENAI_API_KEY: string;
  CLOUDFLARE_API_KEY: string;
  ZAI_API_KEY: string;
  ANTHROPIC_API_KEY: string;
  /** Optional: required only when ANTHROPIC_API_KEY is not scoped to a workspace. */
  ANTHROPIC_WORKSPACE_ID?: string;

  // ── Console sign-in: Google and/or a shared password. Optional on the type so a missing
  // value is a clean 503/hidden button rather than a crash; the console is unusable until
  // at least one method is configured.
  /** Your Google OAuth client id. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Comma-separated operator allowlist; trim+case-insensitive; EMPTY DENIES EVERYONE. */
  OPERATOR_EMAILS?: string;
  /** HMAC key for the console session cookie. Rotating it signs every operator out. */
  ADMIN_SESSION_SECRET?: string;
  /** Optional shared console password, as `pbkdf2-sha256$<iter>$<salt>$<hash>` (make it with
   *  `node scripts/hash-password.mjs`). Unset = password sign-in is off. */
  ADMIN_PASSWORD_HASH?: string;
  /** Optional. Encrypts console-stored provider keys; falls back to NEXUS_MASTER_KEY.
   *  Changing the value in use makes stored keys undecryptable. */
  KEY_ENCRYPTION_SECRET?: string;
  /** Optional. A Cloudflare API token with AI Gateway edit permission on this account (and
   *  nothing else). Lets the console register a custom provider in AI Gateway when you add
   *  one; without it you register it by hand first. */
  AIG_API_TOKEN?: string;
}

/** Upstream kinds — what wire shape the backend speaks. All of them egress through AI
 *  Gateway; the kind selects the translation, not the transport. */
export type UpstreamKind =
  | "openai_chat" // OpenAI shape (translate from Anthropic if needed)
  | "anthropic_native"; // Anthropic shape, NO translation (passthrough)

/** Which reasoning-param dialect a route needs. */
export type ReasoningDialect = "openrouter" | "openai_effort" | "zai_thinking";

export interface ProviderEntry {
  /** AI Gateway slug: a native provider (`groq`, `openai`, `workers-ai`) or a custom one
   *  (`custom-nvidia`, `custom-zai`). Custom providers REQUIRE the `custom-` prefix
   *  in the URL segment even though it is not part of the registered slug. */
  slug: string;
  /** Wire shape / handling. Defaults to `openai_chat`. */
  upstream?: UpstreamKind;
  /** Name of the secret holding the outbound bearer token. Omit for BYOK-only routes. */
  secret?: string;
  /** Pool name — replaces `secret` for multi-key rotation. AI Gateway cannot rotate keys,
   *  so this stays Worker-side; it is why NVIDIA gets ~6x its per-key rate limit. */
  keyPool?: string;
  /** Override the default `/v1/chat/completions`. AI Gateway appends this to the
   *  provider's base_url verbatim, so non-standard endpoints go here (Z.AI's coding and
   *  Anthropic paths). */
  path?: string;
  /** Reasoning-param dialect for the Anthropic-wire `thinking` translation. Named here,
   *  IMPLEMENTED in translate/reasoning.ts — a dialect maps to a function, which is why
   *  this one field cannot simply be derived from the provider name. */
  reasoning?: ReasoningDialect;
  /** Drop `tools` before forwarding (some providers reject the field). */
  dropTools?: boolean;
  /** Send the model id upstream WITH its provider prefix intact, instead of the bare
   *  remainder. Exists for AI Gateway DYNAMIC ROUTES: they are addressed on the `compat`
   *  endpoint as the literal model `dynamic/{route-name}`, so stripping the prefix (the
   *  default, and correct for every real provider) leaves a bare route name that AIG
   *  rejects with `Chat completion bad format`. */
  keepPrefix?: boolean;
  /** Skip every translator — body untouched (native Anthropic upstreams). */
  translate?: "none";
  /** false = registered but refused. Lets a provider be parked without deleting it. */
  enabled?: boolean;
  /** Free-text note shown in the console. */
  note?: string;
}

export interface KeyPoolConfig {
  cooldownMs: number;
  secrets: string[];
}

export interface GatewayConfig {
  /** The provider registry, keyed by the model prefix callers type. This IS the
   *  allowlist: a prefix absent here cannot be reached, which is what stops a virtual
   *  key from spending against a provider you never enabled. */
  providers: Record<string, ProviderEntry>;
  /** Alias → canonical provider (`hf` → `huggingface`). Lets callers migrate naming
   *  without duplicating a whole entry. */
  aliases?: Record<string, string>;
  /** Provider used when the model carries no known prefix. The whole model string is
   *  forwarded. Unset ⇒ unknown models 404 instead of falling through. */
  catchAll?: string;
  keyPools: Record<string, KeyPoolConfig>;
  requestTimeoutMs?: number;
  numRetries?: number;
}

/** Result of matching an incoming `model:` against the route table. */
export interface ResolvedRoute {
  entry: ProviderEntry;
  /** The model id to send upstream (everything after the provider prefix). */
  modelId: string;
  /** Canonical provider name after alias resolution — for logs and /v1/models. */
  provider: string;
}

/** Which wire the client is speaking. */
export type Wire = "openai" | "anthropic";

// ── request/response shapes (only the fields we touch) ──────────────────────

export interface OpenAIMessage {
  role?: string;
  content?: unknown;
  tool_calls?: unknown;
  tool_call_id?: string;
  name?: string;
}

export interface OpenAIChatRequest {
  model: string;
  messages?: OpenAIMessage[];
  stream?: boolean;
  tools?: unknown;
  reasoning_effort?: string;
  reasoning?: unknown;
  thinking?: unknown;
  [k: string]: unknown;
}

export interface AnthropicMessagesRequest {
  model: string;
  messages?: AnthropicMessage[];
  system?: unknown;
  tools?: unknown;
  thinking?: unknown;
  stream?: boolean;
  max_tokens?: number;
  metadata?: { conversation_id?: string };
  [k: string]: unknown;
}

export interface AnthropicMessage {
  role: string;
  content: unknown;
}

export interface VirtualKey {
  key_id: string;
  token_hash: string;
  token_prefix: string;
  key_alias: string | null;
  created_at: number;
  expires_at: number | null;
  revoked_at: number | null;
  max_budget: number | null;
  rpm_limit: number | null;
  tpm_limit: number | null;
}
