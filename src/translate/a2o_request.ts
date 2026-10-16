import type {
  AnthropicMessagesRequest,
  OpenAIChatRequest,
  OpenAIMessage,
  ReasoningDialect,
} from "../types";
import { applyReasoningDialect } from "./reasoning";

/** Convert an Anthropic `/v1/messages` request body to an OpenAI
 *  `/v1/chat/completions` body. System prompt is lifted into a leading system
 *  message; content blocks are flattened (text joined, reasoning dropped — OpenAI
 *  chat treats reasoning as output-only); tool_use ↔ tool_calls and tool_result ↔
 *  the `tool` role; tools use Anthropic `input_schema` → OpenAI `parameters`.
 *
 *  Multi-turn `thinking` blocks are dropped here (P3 re-injects the signed chain via
 *  the ThinkingSessionDO when the route is reasoning-capable). */

interface AnthropicContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  signature?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  source?: unknown;
  cache_control?: unknown;
}

/** An OpenAI text content PART, which — unlike a joined string — can carry a cache
 *  breakpoint. */
interface OpenAITextPart {
  type: "text";
  text: string;
  cache_control?: unknown;
}

/** Turn Anthropic text blocks into OpenAI content, preserving `cache_control`.
 *
 *  ⚠️ **Joining blocks into one string deletes the caller's cache breakpoints**, and
 *  therefore all prompt caching on every translated route. `cache_control` is a property
 *  OF A BLOCK; OpenRouter reads it from an OpenAI content PART, so a breakpoint can only
 *  survive as an array. Anthropic-native routes never come through here (they are
 *  passthrough), which is why this went unnoticed: caching worked where nothing translated
 *  and silently did not where something did.
 *
 *  Alibaba Qwen and Anthropic on OpenRouter require these EXPLICIT breakpoints (OpenAI,
 *  Grok, Moonshot, Groq, DeepSeek, Z.AI and Gemini 2.5 cache automatically and ignore
 *  them). With the breakpoint preserved, most of a repeated prompt comes back
 *  as `cached_tokens`.
 *
 *  Returns a plain STRING when no block carries a breakpoint — the overwhelming majority
 *  of traffic, and the shape every upstream has always accepted. */
function textBlocksToContent(blocks: OpenAITextPart[]): string | OpenAITextPart[] {
  return blocks.some((b) => b.cache_control !== undefined)
    ? blocks
    : blocks.map((b) => b.text).join("");
}

/** Anthropic-wire request fields with no OpenAI `/chat/completions` equivalent.
 *
 *  Line 1 of the conversion spreads the WHOLE Anthropic body (`{...req}`), so
 *  anything not listed here reaches the upstream verbatim. That is deliberate —
 *  a DENY-list, not an allow-list, because callers depend on passing
 *  provider-specific extras straight through (e.g. `chat_template_kwargs`
 *  `{enable_thinking:false}` for self-hosted llama.cpp-style servers). An allow-list
 *  would silently swallow those.
 *
 *  ⚠️ Strict upstreams 400 on unknown fields rather than ignoring them, and the
 *  error names the field, not the caller — so the failure surfaces as a broken
 *  model, not a bad request. Claude Code began sending `output_config` and
 *  `context_management` on every call, which took out a whole
 *  NVIDIA-NIM route this way. When the Anthropic API grows a field, it lands here.
 *
 *  `thinking` is absent on purpose: `applyReasoningDialect` consumes it (Z.AI's
 *  native endpoint WANTS it) and deletes it on the paths that must not see it. */
const ANTHROPIC_ONLY_FIELDS = [
  "system",
  "output_config",
  "context_management",
  "anthropic_version",
  "anthropic_beta",
  "mcp_servers",
  "container",
] as const;

export function anthropicToOpenAIRequest(
  req: AnthropicMessagesRequest,
  modelId: string,
  dialect: ReasoningDialect | undefined,
): OpenAIChatRequest {
  const out: OpenAIChatRequest = { ...req } as OpenAIChatRequest;
  out.model = modelId;

  // ⚠️ **A STREAMED OpenAI response carries NO usage unless you ask for it.** The Anthropic
  // wire always reports usage, so a caller translating to this one gets silence instead —
  // and silence reads as zero. A full agent run over a translated route would report
  // `input_tokens: 0, output_tokens: 0, cost $0.00`, which is not "free", it is "never
  // told". Every agent turn streams, so this would affect effectively all translated
  // traffic.
  //
  // Set only when the caller did not — a caller that opts out (or asks for more) keeps its
  // choice. `stream_options` is standard OpenAI chat-completions and is honoured by
  // OpenRouter, vLLM and llama.cpp alike; it rides the same deny-list-not-allow-list
  // philosophy as the rest of this conversion.
  if (out.stream === true && (out as Record<string, unknown>).stream_options === undefined) {
    (out as Record<string, unknown>).stream_options = { include_usage: true };
  }

  const messages: OpenAIMessage[] = [];

  // system → leading system message
  if (req.system !== undefined && req.system !== null) {
    messages.push({ role: "system", content: systemToContent(req.system) });
  }

  for (const msg of req.messages ?? []) {
    messages.push(...convertMessage(msg.role, msg.content));
  }
  out.messages = hoistSystemMessages(messages);

  // tools
  if (Array.isArray(req.tools)) {
    out.tools = (req.tools as Array<Record<string, unknown>>).map((t) => ({
      type: "function",
      function: {
        name: t.name as string,
        description: t.description as string | undefined,
        parameters: (t.input_schema ?? {}) as Record<string, unknown>,
      },
    }));
  }

  // tool_choice
  if (req.tool_choice && typeof req.tool_choice === "object") {
    out.tool_choice = convertToolChoice(req.tool_choice as { type?: string; name?: string });
  }

  // thinking → route dialect (openrouter reasoning / openai effort), and flatten
  // any content blocks normalizeContent missed (it already ran inside messages).
  applyReasoningDialect(dialect, modelId, out as Record<string, unknown>);

  // Anthropic-only fields the OpenAI endpoint should not see.
  for (const k of ANTHROPIC_ONLY_FIELDS) delete (out as Record<string, unknown>)[k];
  return out;
}

/** Fold every non-leading `system` message into the leading one.
 *
 *  ⚠️ **A `system` message that is not first BREAKS reasoning separation on some
 *  upstreams.** The Anthropic wire has no `system` role inside `messages` (the system
 *  prompt is the top-level `system` field), but Claude Code sends one anyway — a trailing
 *  message carrying the agent listing, skill listing and token budget, appended AFTER the
 *  user turn on every single call. This conversion used to forward that role verbatim, so
 *  the OpenAI body ended `[system, user, system]`.
 *
 *  Observed against a DeepSeek-V4 route with a reasoning-forcing prompt: with the
 *  trailing system message `reasoning_content` came back EMPTY and the full
 *  chain-of-thought was emitted in `content`; with it folded into the leading system
 *  message `reasoning_content` was populated and `content` held only the answer. The
 *  upstream's reasoning parser gives up and inlines everything — so `o2a_response` has no `reasoning_content` to map to a `thinking`
 *  block, and the caller's transcript shows the model's reasoning as a plain assistant
 *  message. The model's reasoning then shows up as a plain assistant message.
 *
 *  Folding, not dropping: the content is real instruction context. Order is preserved,
 *  and a `cache_control` breakpoint on either side survives because the merge keeps the
 *  PART array whenever one is present (joining to a string would delete it — see
 *  `textBlocksToContent`).
 *
 *  Fail-open: no non-leading system message ⇒ the array is returned untouched. */
function hoistSystemMessages(messages: OpenAIMessage[]): OpenAIMessage[] {
  const firstNonSystem = messages.findIndex((m) => m.role !== "system");
  // All-system (or empty) ⇒ nothing is out of place.
  if (firstNonSystem === -1) return messages;
  if (!messages.slice(firstNonSystem).some((m) => m.role === "system")) return messages;

  const systemParts: OpenAITextPart[] = [];
  const rest: OpenAIMessage[] = [];
  for (const m of messages) {
    if (m.role === "system") systemParts.push(...contentToTextParts(m.content));
    else rest.push(m);
  }
  return [{ role: "system", content: textBlocksToContent(joinAdjacentParts(systemParts)) }, ...rest];
}

/** One OpenAI message's content → text PARTS, preserving any `cache_control`. */
function contentToTextParts(content: unknown): OpenAITextPart[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  return (content as Array<OpenAITextPart | string>).map((p) =>
    typeof p === "string"
      ? { type: "text", text: p }
      : {
          type: "text",
          text: p.text ?? "",
          ...(p.cache_control !== undefined ? { cache_control: p.cache_control } : {}),
        },
  );
}

/** Merge runs of breakpoint-free parts, separating the original messages' text with a
 *  blank line. A part CARRYING `cache_control` is never merged into a neighbour — the
 *  breakpoint marks a prefix boundary, so moving it would move the cache split. */
function joinAdjacentParts(parts: OpenAITextPart[]): OpenAITextPart[] {
  const out: OpenAITextPart[] = [];
  for (const p of parts) {
    const prev = out[out.length - 1];
    if (prev && prev.cache_control === undefined && p.cache_control === undefined) {
      prev.text = prev.text ? `${prev.text}\n\n${p.text}` : p.text;
    } else {
      out.push({ ...p });
    }
  }
  return out;
}

function systemToContent(system: unknown): string | OpenAITextPart[] {
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return textBlocksToContent(
      (system as Array<AnthropicContentBlock | string>).map((b) =>
        typeof b === "string"
          ? { type: "text", text: b }
          : {
              type: "text",
              text: b.text ?? "",
              ...(b.cache_control !== undefined ? { cache_control: b.cache_control } : {}),
            },
      ),
    );
  }
  return "";
}

function convertMessage(role: string, content: unknown): OpenAIMessage[] {
  if (typeof content === "string") return [{ role, content }];

  if (!Array.isArray(content)) return [{ role, content: "" }];

  const blocks = content as AnthropicContentBlock[];
  const textParts: OpenAITextPart[] = [];
  const toolCalls: Array<{ index: number; id: string; type: "function"; function: { name: string; arguments: string } }> = [];
  const toolResults: OpenAIMessage[] = [];
  const other: unknown[] = [];

  for (const b of blocks) {
    if (!b || typeof b !== "object") continue;
    switch (b.type) {
      case "text":
        textParts.push({
          type: "text",
          text: b.text ?? "",
          ...(b.cache_control !== undefined ? { cache_control: b.cache_control } : {}),
        });
        break;
      case "thinking":
      case "redacted_thinking":
      case "reasoning":
      case "reasoning_content":
        break; // output-only — dropped for the OpenAI input
      case "tool_use":
        toolCalls.push({
          index: toolCalls.length,
          id: b.name ? (b as { id?: string }).id ?? b.name : (b as { id?: string }).id ?? "",
          type: "function",
          function: { name: b.name ?? "", arguments: JSON.stringify(b.input ?? {}) },
        });
        break;
      case "tool_result": {
        toolResults.push({
          role: "tool",
          tool_call_id: b.tool_use_id ?? "",
          content: resultContentToText(b.content),
        });
        break;
      }
      default:
        // image / multimodal — map image blocks to OpenAI image_url form
        if (b.type === "image" && b.source) {
          const src = b.source as { type?: string; media_type?: string; data?: string; url?: string };
          const url =
            src.type === "base64" && src.data
              ? `data:${src.media_type ?? "image/png"};base64,${src.data}`
              : (src.url ?? "");
          other.push({ type: "image_url", image_url: { url } });
        } else {
          other.push(b);
        }
    }
  }

  const out: OpenAIMessage[] = [];
  // tool_result blocks become `tool` role messages (own messages).
  out.push(...toolResults);
  // The remaining message (text + tool_calls + multimodal) is a single assistant/user msg.
  const isAssistant = role === "assistant";
  const msg: OpenAIMessage = { role };
  if (other.length) {
    // Multimodal already requires an array, so the text parts keep their own breakpoints.
    msg.content = textParts.length ? [...textParts, ...other] : other;
  } else {
    msg.content = textBlocksToContent(textParts);
  }
  if (isAssistant && toolCalls.length) {
    msg.tool_calls = toolCalls;
  }
  out.push(msg);
  return out;
}

function resultContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as AnthropicContentBlock[])
      .map((b) => (typeof b === "string" ? b : b.text ?? JSON.stringify(b)))
      .join("");
  }
  if (content && typeof content === "object") return JSON.stringify(content);
  return String(content ?? "");
}

function convertToolChoice(tc: { type?: string; name?: string }): unknown {
  switch (tc.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "tool":
      return tc.name ? { type: "function", function: { name: tc.name } } : "required";
    case "none":
      return "none";
    default:
      return "auto";
  }
}
