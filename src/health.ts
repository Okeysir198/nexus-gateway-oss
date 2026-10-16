import type { Env, GatewayConfig, ProviderEntry } from "./types";
import { loadConfig, configWarnings } from "./config";
import { aigUrl } from "./upstream/aigateway";
import { json } from "./errors";

/** `/health` — lists every provider. Without `?probe=1` it returns the static config
 *  (fast). With `?probe=1` it actively GETs each provider's `/models` (short timeout,
 *  60s isolate cache) and reports up/down. */

interface Probe {
  status: "up" | "down" | "n/a";
  ms?: number;
  detail?: string;
}
type ProbeMap = Record<string, Probe>;

const cacheTTL = 60_000;
let probedAt = 0;
let probeCache: ProbeMap = {};

/** Resolve one usable key for a probe — the route's secret, or the first live
 *  secret in its pool (the nvidia pool's keys). */
function resolveKey(entry: ProviderEntry, env: Env): string {
  const envRec = env as unknown as Record<string, string>;
  if (entry.secret) return envRec[entry.secret] ?? "";
  if (entry.keyPool) {
    for (const k of [
      "NVIDIA_API_KEY", "NVIDIA_API_KEY_02", "NVIDIA_API_KEY_03",
      "NVIDIA_API_KEY_04", "NVIDIA_API_KEY_05", "NVIDIA_API_KEY_06",
    ]) {
      if (envRec[k]) return envRec[k];
    }
  }
  return "";
}

export async function health(env: Env, request: Request): Promise<Response> {
  const cfg = await loadConfig(env);
  const providers = Object.entries(cfg.providers)
    .filter(([, p]) => p.enabled !== false)
    .map(([name, p]) => ({
      prefix: name,
      upstream: p.upstream ?? "openai_chat",
      // Exposing the slug makes an AI-Gateway bypass visible from outside, not just in
      // the config file.
      aig: p.slug ?? null,
    }));

  // Config drift (unknown enum values, missing aig.slug, undefined keyPool) is reported
  // here rather than only logged.
  const warnings = configWarnings();

  const probe = new URL(request.url).searchParams.get("probe");
  if (probe !== "1") {
    return json(200, { status: warnings.length ? "healthy_with_warnings" : "healthy", providers, warnings });
  }

  const now = Date.now();
  if (now - probedAt > cacheTTL) {
    probeCache = await probeAll(env, cfg);
    probedAt = now;
  }
  const withStatus = providers.map((p) => ({ ...p, ...(probeCache[p.prefix] ?? { status: "n/a" }) }));
  const anyUp = Object.values(probeCache).some((p) => p.status === "up");
  return json(200, { status: anyUp ? "healthy" : "degraded", providers: withStatus, warnings });
}

async function probeAll(env: Env, cfg: GatewayConfig): Promise<ProbeMap> {
  const entries = Object.entries(cfg.providers).filter(([, p]) => p.enabled !== false);
  const results = await Promise.all(
    entries.map(async ([name, entry]) => [name, await probeOne(entry, env)] as const),
  );
  return Object.fromEntries(results);
}

async function probeOne(entry: ProviderEntry, env: Env): Promise<Probe> {
  if (entry.upstream === "anthropic_native") {
    // Anthropic-native upstreams don't serve GET /models on the OpenAI path.
    return { status: "n/a", detail: "anthropic-native (no /models probe)" };
  }
  // Probe THROUGH AI Gateway, same as real traffic. Probing the provider directly would
  // report a provider as "up" while the path production actually uses (AIG → provider)
  // was broken — a green health check for a dead gateway is worse than none.
  if (!entry.slug) return { status: "n/a", detail: "no AI Gateway slug" };
  const url = aigUrl(env, entry.slug, "/v1/models");
  if (!url) return { status: "n/a", detail: "AI Gateway not configured" };
  const key = resolveKey(entry, env);
  const start = Date.now();
  try {
    const r = await fetch(url, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(6_000),
    });
    return { status: r.ok ? "up" : "down", ms: Date.now() - start, detail: r.ok ? undefined : `HTTP ${r.status}` };
  } catch (e) {
    return { status: "down", ms: Date.now() - start, detail: String(e) };
  }
}
