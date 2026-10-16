import { ThinkingSessionDO } from "./thinking_session_do";
import { loadConfig } from "./config";
import { outboundModel, resolveRoute } from "./router";
import { authenticate } from "./auth";
import { pickKey } from "./upstream/openai";
import { callCloudViaAIG, callViaAIGateway } from "./upstream/aigateway";
import { anthropicHeaders, anthropicSurface, proxyAnthropic } from "./upstream/anthropic";
import { health } from "./health";
import { withProviderKeys } from "./provider_keys";
import { applyReasoningDialect } from "./translate/reasoning";
import { anthropicToOpenAIRequest } from "./translate/a2o_request";
import { openaiToAnthropicResponse, type OpenAIResponse } from "./translate/o2a_response";
import { anthropicSseFromOpenAIStream } from "./translate/a2o_stream";
import { conversationDO, deriveConversationId, injectPriorThinking } from "./translate/thinking_session";
import { keyDelete, keyGenerate, keyList } from "./key_webhook";
import { adminPage } from "./admin/page";
import { adminApi } from "./admin/routes";
import { googleCallback, googleStart, loginPage, passwordLogin, requireAdmin } from "./admin/login";
import { errorResponse, json } from "./errors";
import type { AnthropicMessagesRequest, Env, GatewayConfig, ProviderEntry, Wire } from "./types";

export { ThinkingSessionDO };

const CHAT_PATHS = new Set(["/v1/chat/completions", "/v1/completions", "/v1/messages"]);
const DEFAULT_TIMEOUT_MS = 120_000;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const wire: Wire | null =
      path === "/v1/messages" ? "anthropic" : path === "/v1/chat/completions" || path === "/v1/completions" ? "openai" : null;

    try {
      if (path === "/health" || path === "/") return await health(env, request);
      if (path === "/v1/models") return await models(env);
      // Sign-in handshakes (Google, shared password) are OPEN paths, before any console
      // gate: each verifies a credential itself and only then mints the session cookie.
      if (path === "/login/google" && request.method === "GET") return googleStart(env, request);
      if (path === "/login/password" && request.method === "POST") return await passwordLogin(env, request);
      if (path === "/oauth/google/callback" && request.method === "GET") return await googleCallback(env, request);
      if ((path === "/admin" || path === "/admin/login") && request.method === "GET") {
        // Signed in → the console. Otherwise the sign-in page. The page itself never
        // carries a secret; every action behind it is re-authorized server-side.
        const id = await requireAdmin(env, request);
        if (!id.ok) return loginPage(env, request);
        return path === "/admin/login"
          ? Response.redirect(new URL("/admin", request.url).toString(), 302)
          : adminPage(request);
      }

      // /admin/* — console backend (session-gated).
      const adminRes = await adminApi(env, request, path);
      if (adminRes) return adminRes;

      // Key management has its own MASTER-key gate inside each handler, so it sits above
      // the virtual-key gate below rather than inside it.
      if (path === "/key/generate" && request.method === "POST") return await keyGenerate(env, request);
      if (path === "/key/delete" && request.method === "POST") return await keyDelete(env, request);
      if (path === "/key/list" && request.method === "GET") return await keyList(env, request);

      // ── THE virtual-key gate ────────────────────────────────────────────────────
      // Everything past this point is authenticated once, in one place. A gate that must be
      // remembered per route will eventually be forgotten; this one covers any route added
      // below it by default. The token may arrive in `Authorization`, `x-api-key` or
      // `?api_key=` (see extractToken).
      // Narrowed to a non-null Wire so the chat dispatch below needs no re-check.
      const chatWire = wire !== null && CHAT_PATHS.has(path) ? wire : null;
      // Native Anthropic surfaces beyond chat (count_tokens, batches, files, /anthropic/v1/*).
      const anthSurface = anthropicSurface(path);
      if (!chatWire && !anthSurface) return json(404, { error: "not found", path });

      const auth = await authenticate(env, request);
      // BYOK: a token that is not a D1 virtual key may be the caller's OWN provider key,
      // forwarded upstream as their credential (see dispatch). `byokToken` is unset for a
      // missing key and for a D1 outage, so neither degrades into an open door.
      const byok = !auth.ok ? auth.byokToken : undefined;
      if (!auth.ok && !byok) return errorResponse(401, auth.reason ?? "unauthorized", anthSurface ? "anthropic" : wire ?? "openai");

      if (anthSurface && "denied" in anthSurface) {
        return errorResponse(403, anthSurface.denied, "anthropic", "permission_error");
      }

      // Provider keys entered in the console are laid over env here, once, so everything
      // below reads env[secretName] without caring where the value came from.
      const cfg = await loadConfig(env);
      const kenv = await withProviderKeys(env, cfg);

      // Anthropic is a CLOUD provider, so BYOK applies (the caller's own Anthropic key).
      if (anthSurface) return await proxyAnthropic(cfg, kenv, request, anthSurface, url.search, byok);
      return await dispatch(cfg, kenv, ctx, request, chatWire!, cfg.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS, byok);
    } catch (e) {
      const w = wire ?? "openai";
      return errorResponse(500, `gateway error: ${e}`, w, "internal_server_error");
    }
  },

} satisfies ExportedHandler<Env>;

/** Unified dispatch: resolve the model → a provider, then forward through AI Gateway. */
async function dispatch(
  cfg: GatewayConfig,
  env: Env,
  ctx: ExecutionContext,
  request: Request,
  wire: Wire,
  timeoutMs: number,
  /** The caller's own provider key, when they authenticated by BYOK instead of a virtual
   *  key. Replaces the Worker-held secret for this one request; never persisted. */
  byok?: string,
): Promise<Response> {
  const bodyText = await request.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return errorResponse(400, "invalid JSON body", wire);
  }
  // `null`, an array or a scalar parses fine but is not a request body.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return errorResponse(400, "request body must be a JSON object", wire);
  }
  const reqBody = parsed as Record<string, unknown>;
  const model = reqBody.model;
  if (typeof model !== "string" || !model) return errorResponse(400, "missing `model` field", wire);

  const route = resolveRoute(cfg, model);
  if (!route) return errorResponse(404, `no route for model: ${model}`, wire, "not_found_error");
  const entry = route.entry;
  // The model id sent upstream: the remainder after the prefix, or the whole string for a
  // `keepPrefix` entry (AI Gateway dynamic routes).
  const sendModel = outboundModel(route, model);

  // INVARIANT: every provider egresses through Cloudflare AI Gateway. A route without a
  // slug fails loudly here rather than skipping AI Gateway's logging, caching and limits.
  if (!entry.slug) {
    console.error(`provider ${route.provider} has no slug — refusing to bypass AI Gateway`);
    return errorResponse(500, `provider ${route.provider} is misconfigured (no AI Gateway slug)`, wire, "internal_server_error");
  }

  // A dynamic route picks its own provider inside AI Gateway, so a caller cannot know which
  // credential the hop needs. Require a virtual key and spend the Worker's own key.
  if (byok && entry.keepPrefix) {
    return errorResponse(401, `provider ${route.provider} requires a nexus virtual key (the upstream credential is chosen by the route, not the caller)`, wire);
  }

  // ── native-Anthropic provider: forward untouched (zai_anthropic/*) ──
  if (entry.upstream === "anthropic_native" || entry.translate === "none") {
    if (wire !== "anthropic") {
      return errorResponse(400, `provider ${route.provider} is Anthropic-native — use /v1/messages`, wire);
    }
    // The upstream wants the bare model id (glm-4.6), not zai_anthropic/glm-4.6; the body
    // is otherwise forwarded verbatim.
    const anthReq = { ...reqBody, model: route.modelId };
    const key = byok ?? pickKey(cfg, route, env)?.value;
    if (!key) return errorResponse(503, `no API key for provider ${route.provider}`, wire);
    return callViaAIGateway(
      env,
      entry.slug,
      JSON.stringify(anthReq),
      request.headers,
      key,
      timeoutMs,
      entry.path ?? "/v1/messages",
      anthropicHeaders(env, request.headers, byok),
    );
  }

  // ── AI Gateway egress: every other provider (cloud and the key pool) ──
  // Deliberately the only remaining branch: there is no code path to a chat provider that
  // does not go through AI Gateway. Do not add a direct fetch here.
  const aigSlug = entry.slug;
  if (wire === "openai") {
    const reqObj: Record<string, unknown> = { ...reqBody, model: sendModel };
    if (entry.dropTools) delete reqObj.tools;
    applyReasoningDialect(entry.reasoning, sendModel, reqObj);
    return callCloudViaAIG(cfg, route, env, aigSlug, JSON.stringify(reqObj), request.headers, timeoutMs, byok);
  }
  return anthropicChat(env, ctx, entry, sendModel, request, reqBody as unknown as AnthropicMessagesRequest, (body) =>
    callCloudViaAIG(cfg, route, env, aigSlug, body, request.headers, timeoutMs, byok),
  );
}

/** Anthropic-wire path: translate the request, egress via the supplied closure, then
 *  translate the response (streamed or blocking) back to the Anthropic wire. */
async function anthropicChat(
  env: Env,
  ctx: ExecutionContext,
  entry: ProviderEntry,
  sendModel: string,
  request: Request,
  reqObj: AnthropicMessagesRequest,
  egress: (body: string) => Promise<Response>,
): Promise<Response> {
  const openaiReq = anthropicToOpenAIRequest(reqObj, sendModel, entry.reasoning);

  // Reasoning session state (ThinkingSessionDO). Gate on what the CLIENT sent, not on the
  // route: gating on the route would create a Durable Object for every request.
  const reasoningCapable = reqObj.thinking !== undefined;
  let conversationId: string | null = null;
  if (reasoningCapable) {
    conversationId = deriveConversationId(reqObj, request.headers);
    if (conversationId && openaiReq.messages) {
      try {
        const prior = await conversationDO(env, conversationId).loadPriorThinking({
          conversationId,
          model: sendModel,
        });
        injectPriorThinking(openaiReq.messages as Array<Record<string, unknown>>, prior);
      } catch (e) {
        console.error(`thinking load failed: ${e}`);
      }
    }
  }

  const upstream = await egress(JSON.stringify(openaiReq));

  if (!upstream.ok || upstream.body === null) {
    const text = await upstream.text();
    return new Response(
      JSON.stringify({ type: "error", error: { type: "upstream_error", message: text } }),
      { status: upstream.status, headers: { "content-type": "application/json" } },
    );
  }

  const saveThinking = (thinking: import("./thinking_session_do").ThinkingBlock[]): void => {
    if (!conversationId || !thinking.length) return;
    ctx.waitUntil(
      conversationDO(env, conversationId).saveAssistantTurn({
        conversationId,
        model: sendModel,
        blocks: thinking,
      }),
    );
  };

  if (reqObj.stream) {
    const body = anthropicSseFromOpenAIStream(upstream.body, sendModel, saveThinking);
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    });
  }

  const j = (await upstream.json()) as OpenAIResponse;
  const { body: anthropicBody, thinkingBlocks } = openaiToAnthropicResponse(j);
  saveThinking(thinkingBlocks);
  return json(200, anthropicBody);
}

/** GET /v1/models — the enabled providers, plus their aliases. A caller reads this to
 *  learn which prefixes exist; the model half is the provider's own namespace, which we
 *  deliberately do not enumerate (it changes upstream without us). */
async function models(env: Env): Promise<Response> {
  const cfg = await loadConfig(env);
  const ids = Object.entries(cfg.providers)
    .filter(([, p]) => p.enabled !== false)
    .map(([name]) => name);
  for (const [alias, target] of Object.entries(cfg.aliases ?? {})) {
    if (cfg.providers[target]?.enabled !== false) ids.push(alias);
  }
  return json(200, {
    object: "list",
    data: ids.sort().map((id) => ({ id, object: "model", owned_by: "nexus-gateway" })),
  });
}
