import type { Env, GatewayConfig } from "../types";
import { DROP_REQUEST_HEADERS, DROP_RESPONSE_HEADERS, filterHeaders } from "../headers";
import { aigUrl } from "./aigateway";
import { envSecret } from "../config";
import { errorResponse, upstreamError } from "../errors";

/** Native Anthropic API surfaces other than chat: `count_tokens`, Message Batches, Files,
 *  Skills, Models, Managed Agents… everything `api.anthropic.com` serves under `/v1`.
 *
 *  Two ways in, both ending at the AI Gateway `anthropic` provider:
 *  - ROOT, for the siblings of `/v1/messages` a client reaches when its base URL is the bare
 *    gateway host: `/v1/messages/count_tokens` and `/v1/messages/batches*`. The model may
 *    carry the `anthropic/` prefix.
 *  - PREFIXED `/anthropic/v1/*`, for an Anthropic SDK whose base URL is
 *    `https://<gateway>/anthropic`. Nothing enumerates endpoints, so new ones just work.
 *
 *  ⚠️ Files, batches and skills belong to the Anthropic ORG, not to a nexus key: any virtual
 *  key that learns another's batch/file id can read it. That is accepted, not solved. */

const UPSTREAM_TIMEOUT_MS = 600_000; // batch results / file content stream far past 120s
const MAX_REWRITE_BYTES = 4 * 1024 * 1024; // bigger JSON bodies stream through untouched
const DENIED_SEGMENTS = new Set(["organizations", "oauth"]);
const METHODS = new Set(["GET", "HEAD", "POST", "DELETE"]);

export type AnthropicSurface =
  | { upstreamPath: string; prefixed: boolean }
  | { denied: string };

/** Classify a request path. `null` = not an Anthropic-native surface (the caller's own
 *  routing decides). ⚠️ `organizations` is the Admin API: our key can reach it, a virtual
 *  key must not — checked on the DECODED path, because upstream decodes `%6Frganizations`. */
export function anthropicSurface(path: string): AnthropicSurface | null {
  const prefixed = path.startsWith("/anthropic/") || path === "/anthropic";
  const p = prefixed ? path.slice("/anthropic".length) : path;

  let decoded: string;
  try {
    decoded = decodeURIComponent(p);
  } catch {
    return prefixed ? { denied: "malformed path" } : null;
  }
  if (prefixed && !decoded.startsWith("/v1/")) return { denied: "path must be under /anthropic/v1/" };
  if (decoded.includes("..") || decoded.includes("\\")) return { denied: "path not allowed" };

  if (prefixed) {
    const seg = decoded.split("/")[2] ?? "";
    if (DENIED_SEGMENTS.has(seg)) return { denied: `/v1/${seg} is not exposed` };
    return { upstreamPath: p, prefixed };
  }
  if (p === "/v1/messages/count_tokens" || p === "/v1/messages/batches" || p.startsWith("/v1/messages/batches/")) {
    return { upstreamPath: p, prefixed };
  }
  return null;
}

/** `anthropic/claude-haiku-5-5` and `anthropic:claude-haiku-5-5` → `claude-haiku-5-5`. */
export function stripAnthropicPrefix(model: string): string {
  return model.replace(/^anthropic[:/]/, "");
}

/** Model-id prefixes in a JSON body: top-level `model` (messages, count_tokens) and
 *  `requests[].params.model` (batch create). Returns the text unchanged when it is not
 *  JSON or names no model, so a malformed body reaches Anthropic and gets ITS error. */
export function normalizeModels(text: string): string {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return text;
  }
  if (!body || typeof body !== "object") return text;
  const b = body as { model?: unknown; requests?: unknown };
  let changed = false;
  if (typeof b.model === "string" && stripAnthropicPrefix(b.model) !== b.model) {
    b.model = stripAnthropicPrefix(b.model);
    changed = true;
  }
  if (Array.isArray(b.requests)) {
    for (const r of b.requests) {
      const params = (r as { params?: { model?: unknown } } | null)?.params;
      if (params && typeof params.model === "string" && stripAnthropicPrefix(params.model) !== params.model) {
        params.model = stripAnthropicPrefix(params.model);
        changed = true;
      }
    }
  }
  return changed ? JSON.stringify(body) : text;
}

/** Headers api.anthropic.com needs that the generic egress does not set: a REQUIRED
 *  `anthropic-version` (defaulted) and, for OUR key only, the workspace id. A BYOK
 *  caller's key is theirs — our workspace id would contradict it. */
export function anthropicHeaders(env: Env, reqHeaders: Headers, byok?: string): Record<string, string> {
  const out: Record<string, string> = {
    "anthropic-version": reqHeaders.get("anthropic-version") ?? "2023-06-01",
  };
  const beta = reqHeaders.get("anthropic-beta");
  if (beta) out["anthropic-beta"] = beta;
  if (!byok && env.ANTHROPIC_WORKSPACE_ID) out["anthropic-workspace-id"] = env.ANTHROPIC_WORKSPACE_ID;
  return out;
}

/** Forward one native-Anthropic request through AI Gateway. */
export async function proxyAnthropic(
  cfg: GatewayConfig,
  env: Env,
  request: Request,
  surface: { upstreamPath: string; prefixed: boolean },
  search: string,
  byok?: string,
): Promise<Response> {
  if (!METHODS.has(request.method)) return errorResponse(405, `method ${request.method} not allowed`, "anthropic");

  const entry = cfg.providers["anthropic"];
  if (!entry || entry.enabled === false) return errorResponse(404, "anthropic provider is not configured", "anthropic", "not_found_error");

  const key = byok ?? (entry.secret ? envSecret(env, entry.secret) : "");
  if (!key) return errorResponse(503, "no API key for provider anthropic", "anthropic");

  const isJson = (request.headers.get("content-type") ?? "").toLowerCase().includes("application/json");
  const hasBody = request.method === "POST" || request.method === "DELETE";
  let body: BodyInit | null = null;
  if (hasBody) {
    const len = Number(request.headers.get("content-length") ?? "0");
    if (isJson && len <= MAX_REWRITE_BYTES) {
      const text = await request.text();
      // The ROOT surface is `anthropic/*` territory: a model naming another provider
      // would reach Anthropic as an unknown model and fail with a confusing 404.
      if (!surface.prefixed && request.method === "POST" && surface.upstreamPath === "/v1/messages/count_tokens") {
        const m = (() => { try { return (JSON.parse(text) as { model?: unknown }).model; } catch { return undefined; } })();
        if (typeof m === "string" && /^[^:/]+[:/]/.test(m) && !/^anthropic[:/]/.test(m)) {
          return errorResponse(400, "count_tokens is only available for anthropic/* models", "anthropic");
        }
      }
      body = normalizeModels(text);
    } else {
      body = request.body; // multipart uploads and oversized JSON are never buffered
    }
  }

  const url = aigUrl(env, entry.slug, surface.upstreamPath, search);
  if (!url) return upstreamError(503, "AI Gateway not configured (CF_ACCOUNT_ID/AIG_GATEWAY_ID)", "server_error");

  const headers = filterHeaders(request.headers, DROP_REQUEST_HEADERS);
  // A caller must not steer AI Gateway (cache ttl, custom cost, gateway token) or pick a
  // workspace under our key.
  for (const name of [...headers.keys()]) {
    if (name.startsWith("cf-aig-") || name === "anthropic-workspace-id") headers.delete(name);
  }
  if (byok) {
    const ws = request.headers.get("anthropic-workspace-id");
    if (ws) headers.set("anthropic-workspace-id", ws);
  }
  headers.set("x-api-key", key);
  for (const [k, v] of Object.entries(anthropicHeaders(env, request.headers, byok))) headers.set(k, v);

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : body,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (e) {
    return upstreamError(502, `AI Gateway egress failed: ${e}`, "server_error");
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: filterHeaders(upstream.headers, DROP_RESPONSE_HEADERS),
  });
}
