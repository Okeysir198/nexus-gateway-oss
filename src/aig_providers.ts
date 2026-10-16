import type { Env } from "./types";

/** Register a custom provider in Cloudflare AI Gateway from the console, so adding a
 *  provider is one form instead of a form plus a `curl`.
 *
 *  Needs the optional `AIG_API_TOKEN` secret: a Cloudflare API token scoped to AI Gateway
 *  edit on this account, and nothing else. Without it the console falls back to asking the
 *  operator to register the provider by hand. The token never leaves the Worker and no
 *  response echoes it. */

const API = "https://api.cloudflare.com/client/v4";
const TIMEOUT_MS = 10_000;

export class AigError extends Error {}

/** A custom provider's base URL must be a bare https origin. AI Gateway appends the request
 *  path to it, and the provider's own API path lives in the route entry. Returns the
 *  normalised URL (no trailing slash), or throws with a message fit for the operator. */
export function validateBaseUrl(raw: unknown, ownHost: string): string {
  if (typeof raw !== "string") throw new AigError("base URL must be text");
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new AigError("base URL is not a valid URL");
  }
  if (u.protocol !== "https:") throw new AigError("base URL must start with https://");
  if (u.username || u.password) throw new AigError("base URL must not contain credentials");
  if (u.pathname !== "/" || u.search || u.hash) {
    throw new AigError("base URL must be just the host (for example https://api.example.com); the API path goes under Advanced");
  }
  const host = u.hostname.toLowerCase();
  if (!host.includes(".") || /^[\d.]+$/.test(host) || host.includes(":") || /(^|\.)(localhost|local|internal)$/.test(host)) {
    throw new AigError("base URL must be a public host name");
  }
  // A provider that points back at this Worker would loop every request into it.
  if (host === ownHost.toLowerCase()) throw new AigError("base URL must not be this gateway's own host");
  return u.origin;
}

async function cf<T>(env: Env, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}/accounts/${env.CF_ACCOUNT_ID}/ai-gateway${path}`, {
    method,
    headers: { authorization: `Bearer ${env.AIG_API_TOKEN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const j = (await res.json().catch(() => null)) as
    | { success?: boolean; result?: T; errors?: { message?: string }[] }
    | null;
  if (!res.ok || !j?.success) {
    const why = j?.errors?.map((e) => e.message).filter(Boolean).join("; ") || `HTTP ${res.status}`;
    throw new AigError(`Cloudflare refused the request: ${why}${res.status === 403 ? " (does AIG_API_TOKEN have AI Gateway edit permission?)" : ""}`);
  }
  return j.result as T;
}

/** Make sure `slug` (with its `custom-` prefix) exists in AI Gateway pointing at `baseUrl`.
 *  "exists" means it was already registered to the same URL; a different URL is an error,
 *  never a silent repoint of a provider other routes may use. */
export async function ensureCustomProvider(
  env: Env,
  slug: string,
  baseUrl: string,
): Promise<"registered" | "exists"> {
  if (!env.AIG_API_TOKEN) throw new AigError("AIG_API_TOKEN is not set");
  const bare = slug.replace(/^custom-/, "");
  const existing = await cf<{ slug: string; base_url?: string }[]>(env, "GET", "/custom-providers");
  const found = (Array.isArray(existing) ? existing : []).find((p) => p.slug === bare);
  if (found) {
    if ((found.base_url ?? "").replace(/\/+$/, "") === baseUrl) return "exists";
    throw new AigError(`${slug} is already registered in AI Gateway with a different base URL (${found.base_url}); change it there or pick another slug`);
  }
  await cf(env, "POST", "/custom-providers", { name: bare, slug: bare, base_url: baseUrl, enable: true });
  return "registered";
}
