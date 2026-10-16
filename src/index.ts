import { ThinkingSessionDO } from "./thinking_session_do";
import { loadConfig } from "./config";
import { outboundModel, resolveRoute } from "./router";
import { authenticate } from "./auth";
import { pickKey } from "./upstream/openai";
import { callCloudViaAIG, callViaAIGateway } from "./upstream/aigateway";
import { anthropicHeaders, anthropicSurface, proxyAnthropic } from "./upstream/anthropic";
import { health } from "./health";
import { applyReasoningDialect } from "./translate/reasoning";
import { anthropicToOpenAIRequest } from "./translate/a2o_request";
import { openaiToAnthropicResponse, type OpenAIResponse } from "./translate/o2a_response";
import { anthropicSseFromOpenAIStream } from "./translate/a2o_stream";
import { conversationDO, deriveConversationId, injectPriorThinking } from "./translate/thinking_session";
import { keyDelete, keyGenerate, keyList } from "./key_webhook";
import { adminPage } from "./admin/page";
import { adminApi } from "./admin/routes";
import { googleCallback, googleStart, loginPage, requireAdmin } from "./admin/login";
import { errorResponse, json } from "./errors";
import type { Env, GatewayConfig, ProviderEntry, Wire } from "./types";

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
      // The Google sign-in handshake — OPEN paths, before any console gate. Google
      // identifies; OPERATOR_EMAILS (fail-closed) authorizes; the cookie is minted only
      // after both agree. GET /admin/login redirects to the console page, which
      // shows the Google sign-in when unauthenticated.
      if (path === "/login/google" && request.method === "GET") return googleStart(env, request);
      if (path === "/oauth/google/callback" && request.method === "GET") return await googleCallback(env, request);
      if ((path === "/admin" || path === "/admin/login") && request.method === "GET") {
        // Signed in → the console. Otherwise the sign-in page. The page itself never
        // carries a secret; every action behind it is re-authorized server-side.
        const id = await requireAdmin(env, request);
        if (!id.ok) return loginPage(request);
        return path === "/admin/login"
          ? Response.redirect(new URL("/admin", request.url).toString(), 302)
          : adminPage(request);
      }

      // /admin/* — console backend (session-gated: Google sign-in session cookie).
      const adminRes = await adminApi(env, request, path);
      if (adminRes) return adminRes;

      // Key management has its own MASTER-key gate inside each handler, so it sits above
      // the virtual-key gate below rather than inside it.
      if (path === "/key/generate" && request.method === "POST") return await keyGenerate(env, request);
      if (path === "/key/delete" && request.method === "POST") return await keyDelete(env, request);
      if (path === "/key/list" && request.method === "GET") return await keyList(env, request);

      // ── THE virtual-key gate ────────────────────────────────────────────────────
      // Everything past this point is D1-authed, once, in one place. A gate that must be
      // remembered per route is a gate that will eventually be forgotten; this one covers
      // any route added below it by default.
      //
      // ⚠️ The token must be in the Authorization header, `x-api-key`, or `?api_key=`
      // (see extractToken).
      // Narrowed to a non-null Wire so the chat dispatch below needs no re-check.
      const chatWire = wire !== null && CHAT_PATHS.has(path) ? wire : null;
      // Native Anthropic surfaces beyond chat (count_tokens, batches, files, /anthropic/v1/*).
      const anthSurface = anthropicSurface(path);
      if (!chatWire && !anthSurface) return json(404, { error: "not found", path });

      const auth = await authenticate(env, request);
      // BYOK: a token that is not a D1 virtual key may still be the caller's OWN cloud
      // provider key, forwarded upstream verbatim (see dispatch). Allowed on the CHAT
      // paths only. `byokToken` is unset for "missing API key" and for a D1 outage, so
      // neither degrades into an open door.
      const byok = (chatWire || anthSurface) && !auth.ok ? auth.byokToken : undefined;
      if (!auth.ok && !byok) return errorResponse(401, auth.reason ?? "unauthorized", anthSurface ? "anthropic" : wire ?? "openai");

      // Anthropic is a CLOUD provider, so BYOK applies (the caller's own Anthropic key).
      if (anthSurface) {
        if ("denied" in anthSurface) return errorResponse(403, anthSurface.denied, "anthropic", "permission_error");
        return await proxyAnthropic(await loadConfig(env), env, request, anthSurface, url.search, byok);
      }

      const cfg = await loadConfig(env);
      return await dispatch(cfg, env, ctx, request, chatWire!, cfg.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS, byok);
    } catch (e) {
      const w = wire ?? "openai";
      return errorResponse(500, `gateway error: ${e}`, w, "internal_server_error");
    }
  },

  // No `scheduled` handler, and no [triggers] block in wrangler.toml. If a cron is ever
  // added, add both in the same commit — a trigger without a handler fires into a Worker
  // that can't handle it.
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
  let parsed: { model?: string } = {};
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return errorResponse(400, "invalid JSON body", wire);
  }
  const model = parsed.model;
  if (!model) return errorResponse(400, "missing `model` field", wire);

  const route = resolveRoute(cfg, model);
  if (!route) return errorResponse(404, `no route for model: ${model}`, wire, "not_found_error");
  const entry = route.entry;
  // Everything after the provider prefix. The whole string for a catch-all hit, since
  // to that provider there was never a prefix to strip — or for a `keepPrefix` entry
  // (AI Gateway dynamic routes), where the prefix IS part of the model id upstream.
  const sendModel = outboundModel(route, model);

  // INVARIANT: every provider egresses through Cloudflare AI Gateway. Enforced here, not
  // just asserted in config, so an entry added without a slug fails loudly at the edge
  // instead of quietly opening a direct path that skips AIG's logging, caching and rate
  // limiting. The Worker has no non-AIG egress.
  if (!entry.slug) {
    console.error(`provider ${route.provider} has no slug — refusing to bypass AI Gateway`);
    return errorResponse(500, `provider ${route.provider} is misconfigured (no AI Gateway slug)`, wire, "internal_server_error");
  }

  // A dynamic route picks its own provider inside AI Gateway, so the caller cannot know
  // which credential the hop needs — BYOK is meaningless here and would surface as a
  // confusing upstream 401. Require a virtual key and spend the Worker's own pool key.
  if (byok && entry.keepPrefix) {
    return errorResponse(401, `provider ${route.provider} requires a nexus virtual key (the upstream credential is chosen by the route, not the caller)`, wire);
  }

  // ── native-Anthropic provider: forward untouched (zai_anthropic/*) ──
  if (entry.upstream === "anthropic_native" || entry.translate === "none") {
    if (wire !== "anthropic") {
      return errorResponse(400, `provider ${route.provider} is Anthropic-native — use /v1/messages`, wire);
    }
    // Strip the route prefix — the upstream wants the bare model id (glm-4.6), not
    // zai_anthropic/glm-4.6. Body is otherwise Anthropic-shape, forwarded verbatim.
    const anthReq = JSON.parse(bodyText) as Record<string, unknown>;
    anthReq.model = route.modelId;
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

  // ── AI Gateway egress: cloud providers and the NVIDIA pool — i.e. everything else ──
  //
  // There is no `else` here on purpose. Combined with the guard above, the Worker has NO
  // code path that reaches a chat provider except through AI Gateway — the invariant is
  // structural, not a convention someone must remember. Re-adding a direct fetch here
  // would silently reopen that hole.
  const aigSlug = entry.slug;
  if (wire === "openai") {
    const reqObj = JSON.parse(bodyText) as Record<string, unknown>;
    reqObj.model = sendModel;
    if (entry.dropTools) delete reqObj.tools;
    applyReasoningDialect(entry.reasoning, sendModel, reqObj);
    return callCloudViaAIG(cfg, route, env, aigSlug, JSON.stringify(reqObj), request.headers, timeoutMs, byok);
  }
  return anthropicChat(env, ctx, entry, sendModel, request, bodyText, (body) =>
    callCloudViaAIG(cfg, route, env, aigSlug, body, request.headers, timeoutMs, byok),
  );
}

/** Anthropic-wire path: translate the request, egress via the supplied closure, then
 *  translate the response (streamed or blocking) back to the Anthropic wire.
 *
 *  Takes the egress as a CLOSURE rather than a route/config pair so the caller decides
 *  which AI Gateway slug and timeout apply — this function does not need to know. */
async function anthropicChat(
  env: Env,
  ctx: ExecutionContext,
  entry: ProviderEntry,
  sendModel: string,
  request: Request,
  bodyText: string,
  egress: (body: string) => Promise<Response>,
): Promise<Response> {
  const reqObj = JSON.parse(bodyText) as import("./types").AnthropicMessagesRequest;
  const openaiReq = anthropicToOpenAIRequest(reqObj, sendModel, entry.reasoning);

  // Reasoning session state (ThinkingSessionDO).
  // Gate on what the CLIENT sent, not on the route being reasoning-capable:
  // gating on the route would instantiate a Durable Object for every request. The DO
  // exists to carry thinking blocks across turns; if the caller isn't driving a
  // reasoning loop there is nothing to carry.
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
