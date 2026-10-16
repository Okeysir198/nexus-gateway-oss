-- The gateway's virtual-key store. Applied with:
--   wrangler d1 execute nexus_keys --remote --file=schema.sql
--
-- D1 is the SOLE authority: the Worker mints and revokes keys here directly. Some columns
-- (key_alias, max_budget, ...) follow the common LiteLLM vocabulary. D1 (not KV) because auth needs strong
-- consistency — a revocation must not be servable from a stale replica.
--
-- Only the SHA-256 of a token is stored. The raw token is returned once, at mint time,
-- and never persisted (`upsertKey` in src/keys_db.ts strips `key`/`token` from `raw_json`).

CREATE TABLE IF NOT EXISTS virtual_keys (
  key_id        TEXT PRIMARY KEY,            -- 'key-<uuid>'; legacy rows hold the token_hash
  token_hash    TEXT UNIQUE NOT NULL,        -- sha256 of the sk-... token — the lookup key
  token_prefix  TEXT NOT NULL,               -- first 12 chars, for the console + debug logs
  key_alias     TEXT,
  created_at    INTEGER NOT NULL,            -- epoch SECONDS (see keys_db.toEpochSeconds)
  expires_at    INTEGER,                     -- epoch SECONDS, nullable
  revoked_at    INTEGER,
  max_budget    REAL,                        -- stored, NOT enforced at the edge
  rpm_limit     INTEGER,                     -- stored, NOT enforced at the edge
  tpm_limit     INTEGER,                     -- stored, NOT enforced at the edge
  raw_json      TEXT NOT NULL                -- forward-compat spillover; MUST NOT hold a token
);

-- Partial index matching the hot lookup exactly (keys_db.lookupKey filters on both).
-- token_hash's UNIQUE constraint already creates an index; this narrower one is what the
-- planner actually wants for the live-key path.
CREATE INDEX IF NOT EXISTS idx_token_hash
  ON virtual_keys(token_hash)
  WHERE revoked_at IS NULL;

-- listKeys()/the admin console order by this; without it every page load is a full scan.
CREATE INDEX IF NOT EXISTS idx_created_at
  ON virtual_keys(created_at DESC);

-- Provider registry. Overlays the bundled config.default.json: a row here wins, and a
-- provider present ONLY here needs no deploy — which is the whole point. The bundled
-- config remains the fallback so a fresh/empty D1 still serves traffic.
--
-- This is also the allowlist. A prefix that is neither here (enabled) nor in the bundled
-- config cannot be reached, which is what stops a virtual key spending against a provider
-- nobody enabled. Under AI Gateway Unified Billing that would be your invoice.
CREATE TABLE IF NOT EXISTS providers (
  name        TEXT PRIMARY KEY,            -- the model prefix callers type ('groq')
  slug        TEXT NOT NULL,               -- AI Gateway slug ('groq', 'custom-nvidia')
  upstream    TEXT NOT NULL DEFAULT 'openai_chat',
  secret      TEXT,                        -- env var holding the bearer; NULL = none/BYOK
  key_pool    TEXT,                        -- multi-key rotation (AIG cannot rotate)
  path        TEXT,                        -- override /v1/chat/completions
  reasoning   TEXT,                        -- dialect NAME; implemented in code
  drop_tools  INTEGER NOT NULL DEFAULT 0,
  translate   TEXT,                        -- 'none' = no wire translation
  enabled     INTEGER NOT NULL DEFAULT 1,
  note        TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Alias → canonical provider, so callers migrate naming without a duplicate entry.
CREATE TABLE IF NOT EXISTS provider_aliases (
  alias      TEXT PRIMARY KEY,
  target     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Console operators are not stored here: the allowlist is the OPERATOR_EMAILS var and
-- sessions are stateless HMAC cookies keyed by ADMIN_SESSION_SECRET.
