import type { ReasoningDialect } from "../types";

// PROVIDER-keyed (acts on the route, never a model allowlist) so the gateway stays model-agnostic. All functions
// are pure and fail-open — a bug here must never break a request.

/** Reasoning block types OpenAI chat/completions does not accept in input. */
const REASONING_TYPES = new Set(["thinking", "redacted_thinking", "reasoning", "reasoning_content"]);

/** Request params OpenAI accepts ONLY on reasoning models. */
const OPENAI_REASONING_PARAMS = ["reasoning_effort", "reasoning"];

/** Leaf model id (after the last `/` or `:`), lowercased. */
function leaf(model: string): string {
  return model.split("/").pop()!.split(":").pop()!.toLowerCase();
}

/** True ⇒ this OpenAI model does NOT accept `reasoning_effort` → strip it. Keeps the
 *  param ONLY for the o-series and gpt-5* (except the non-reasoning gpt-5-chat). */
function isOpenaiNonReasoning(model: string): boolean {
  const l = leaf(model);
  if (l.startsWith("o1") || l.startsWith("o3") || l.startsWith("o4") || l.startsWith("o5")) {
    return false;
  }
  if (l.startsWith("gpt-5") && !l.includes("chat")) {
    return false;
  }
  return true;
}

/** Carry an Anthropic-wire `thinking` onto OpenRouter's native `reasoning` param.
 *  thinking:{type:disabled} → reasoning:{enabled:false}
 *  thinking:{type:enabled,budget_tokens:N} → reasoning:{max_tokens:N}
 *  thinking:{type:enabled} → reasoning:{enabled:true}
 *  An explicit `reasoning`/`reasoning_effort` already present is never overwritten. */
export function translateThinkingForOpenRouter(req: Record<string, unknown>): boolean {
  const thinking = req.thinking;
  if (thinking === undefined) return false;
  delete req.thinking;
  if (req.reasoning !== undefined || req.reasoning_effort !== undefined) return true;
  if (typeof thinking !== "object" || thinking === null) return true;
  const t = thinking as { type?: string; budget_tokens?: number };
  if (t.type === "disabled") req.reasoning = { enabled: false };
  else if (typeof t.budget_tokens === "number") req.reasoning = { max_tokens: t.budget_tokens };
  else req.reasoning = { enabled: true };
  return true;
}

/** Reconcile reasoning params for an OpenAI target: strip them on non-reasoning
 *  models; downgrade 'minimal' → 'low' on reasoning models. */
export function fixOpenaiReasoningParams(model: string, req: Record<string, unknown>): boolean {
  const nonReasoning = isOpenaiNonReasoning(model);
  let changed = false;

  // `thinking` is an ANTHROPIC field and OpenAI's /chat/completions rejects unknown
  // params — so it must never survive, reasoning-capable model or not. It gets here
  // because a2o_request builds the OpenAI body with `{...req}`, copying every Anthropic
  // field wholesale. Previously only the non-reasoning branch below cleaned up (and it
  // only cleans `reasoning`/`reasoning_effort`), so an Anthropic-wire call to a
  // reasoning-capable openai/* model forwarded `thinking` and drew a 400.
  if (req.thinking !== undefined) {
    delete req.thinking;
    changed = true;
  }
  if (nonReasoning) {
    for (const k of OPENAI_REASONING_PARAMS) {
      if (req[k] !== undefined) {
        delete req[k];
        changed = true;
      }
    }
    return changed;
  }
  if (req.reasoning_effort === "minimal") {
    req.reasoning_effort = "low";
    changed = true;
  }
  const r = req.reasoning as { effort?: string } | undefined;
  if (r && typeof r === "object" && r.effort === "minimal") {
    r.effort = "low";
    changed = true;
  }
  return changed;
}

/** Flatten a message's `content` list to OpenAI form: join text into a single
 *  string, drop reasoning blocks (output-only), preserve multimodal blocks.
 *
 *  ⚠️ **A block carrying `cache_control` is never joined.** This runs AFTER
 *  `a2o_request` has already converted the message, so it is the second place a cache
 *  breakpoint can be destroyed — and it silently undid the fix in the first place until
 *  a test caught it. `cache_control` is a property of a BLOCK; joining blocks into one
 *  string deletes it, and with it all prompt caching on every translated route
 *  (OpenRouter reads breakpoints from an OpenAI content PART). */
export function normalizeContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  const textParts: Array<{ type: "text"; text: string; cache_control?: unknown }> = [];
  const other: unknown[] = [];
  let cached = false;
  for (const block of content) {
    if (typeof block === "string") {
      textParts.push({ type: "text", text: block });
      continue;
    }
    if (typeof block !== "object" || block === null) {
      textParts.push({ type: "text", text: String(block) });
      continue;
    }
    const b = block as { type?: string; text?: string; cache_control?: unknown };
    if (b.type && REASONING_TYPES.has(b.type)) continue;
    if (b.type === "text") {
      cached ||= b.cache_control !== undefined;
      textParts.push({
        type: "text",
        text: b.text ?? "",
        ...(b.cache_control !== undefined ? { cache_control: b.cache_control } : {}),
      });
    } else other.push(block);
  }
  if (other.length) {
    if (!textParts.length) return other;
    return cached
      ? [...textParts, ...other]
      : [{ type: "text", text: textParts.map((t) => t.text).join("") }, ...other];
  }
  return cached ? textParts : textParts.map((t) => t.text).join("");
}

/** Z.AI (GLM) dialect: the coding endpoint takes a NATIVE `thinking` object, so the
 *  Anthropic-shaped `thinking` block is normalized rather than dropped.
 *
 *  A dialect declared in config but missing here would fall to the `else` arm and have
 *  `thinking` DELETED — the opposite of the intent, silently. The config validator
 *  (`validateConfig`) warns on any dialect value this union does not know.
 *
 *  Anthropic sends `{type:"enabled", budget_tokens:N}`; Z.AI wants `{type:"enabled"}` and
 *  ignores a budget, so the budget is dropped. OpenAI-style `reasoning_effort` is also
 *  cleared — sending both confuses the upstream. */
function zaiThinking(req: Record<string, unknown>): void {
  const t = req.thinking;
  if (t && typeof t === "object") {
    const type = (t as { type?: unknown }).type;
    req.thinking = { type: type === "disabled" ? "disabled" : "enabled" };
  } else if (typeof t === "boolean") {
    req.thinking = { type: t ? "enabled" : "disabled" };
  } else if (t !== undefined) {
    delete req.thinking;
  }
  delete req.reasoning;
  delete req.reasoning_effort;
}

/** Apply the route's reasoning dialect to an OpenAI-shaped request body (the
 *  Anthropic→OpenAI request translation). `messages` content blocks are flattened
 *  regardless of dialect (OpenAI chat never accepts reasoning blocks in input). */
export function applyReasoningDialect(
  dialect: ReasoningDialect | undefined,
  model: string,
  req: Record<string, unknown>,
): void {
  if (dialect === "openrouter") {
    translateThinkingForOpenRouter(req);
  } else if (dialect === "openai_effort") {
    fixOpenaiReasoningParams(model, req);
  } else if (dialect === "zai_thinking") {
    zaiThinking(req);
  } else {
    // No dialect (nvidia_nim / vLLM control reasoning via chat_template_kwargs the
    // client sends directly) — but still drop a stray `thinking` key the bridge
    // may have copied, so OpenAI-compat upstreams don't 400 on it.
    delete req.thinking;
  }
  const messages = req.messages;
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      if (msg && typeof msg === "object" && "content" in msg) {
        const m = msg as { content: unknown };
        const norm = normalizeContent(m.content);
        if (norm !== m.content) m.content = norm;
      }
    }
  }
}
