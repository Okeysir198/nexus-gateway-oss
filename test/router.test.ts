import { describe, expect, it } from "vitest";
import { outboundModel, resolveRoute, splitModel } from "../src/router";
import bundled from "../config.default.json";
import type { GatewayConfig } from "../src/types";

/** Model resolution is on the path of EVERY request and is a pure function over plain
 *  data, which makes it the cheapest high-value test in the repo. */

// Mirror what loadConfig() does: drop `_comment` keys and apply `defaults`.
function prepare(raw: unknown): GatewayConfig {
  const c = JSON.parse(JSON.stringify(raw)) as GatewayConfig;
  const d = (c as unknown as { defaults?: Record<string, unknown> }).defaults ?? {};
  const providers: GatewayConfig["providers"] = {};
  for (const [k, v] of Object.entries(c.providers ?? {})) {
    if (k.startsWith("_")) continue;
    providers[k] = { upstream: "openai_chat", ...d, ...v } as GatewayConfig["providers"][string];
  }
  const aliases: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.aliases ?? {})) if (!k.startsWith("_")) aliases[k] = v;
  return { ...c, providers, aliases };
}

const cfg = prepare(bundled);

function mk(providers: string[], aliases: Record<string, string> = {}, catchAll?: string): GatewayConfig {
  return {
    providers: Object.fromEntries(providers.map((p) => [p, { slug: p, upstream: "openai_chat" as const }])),
    aliases,
    catchAll,
    keyPools: {},
  };
}

describe("splitModel", () => {
  it("splits on the first separator, whichever it is", () => {
    expect(splitModel("groq/llama-3.3")).toEqual({ prefix: "groq", rest: "llama-3.3" });
    expect(splitModel("groq:llama-3.3")).toEqual({ prefix: "groq", rest: "llama-3.3" });
  });

  it("keeps internal slashes in the model id", () => {
    // Provider model ids routinely contain slashes — only the FIRST one is a separator.
    expect(splitModel("openrouter/deepseek/deepseek-v4")).toEqual({
      prefix: "openrouter",
      rest: "deepseek/deepseek-v4",
    });
  });

  it("treats a colon AFTER a slash as part of the model id", () => {
    // Splitting on whichever separator comes first handles this by construction.
    expect(splitModel("myprov/qwen:7b")).toEqual({ prefix: "myprov", rest: "qwen:7b" });
  });

  it("returns no prefix for a bare model", () => {
    expect(splitModel("gpt-5")).toEqual({ prefix: null, rest: "gpt-5" });
  });

  it("does not treat a leading separator as a prefix", () => {
    expect(splitModel("/weird")).toEqual({ prefix: null, rest: "/weird" });
  });
});

describe("resolveRoute", () => {
  it("resolves a known prefix and strips it", () => {
    const r = resolveRoute(cfg, "groq/llama-3.3-70b-versatile");
    expect(r?.provider).toBe("groq");
    expect(r?.modelId).toBe("llama-3.3-70b-versatile");
  });

  it("accepts the colon form identically", () => {
    const a = resolveRoute(cfg, "groq:llama-3.3");
    const b = resolveRoute(cfg, "groq/llama-3.3");
    expect(a?.provider).toBe(b?.provider);
    expect(a?.modelId).toBe(b?.modelId);
  });

  it("follows aliases to the canonical provider", () => {
    for (const [alias, target] of Object.entries(cfg.aliases ?? {})) {
      const r = resolveRoute(cfg, `${alias}/some-model`);
      expect(r?.provider, `${alias} should resolve to ${target}`).toBe(target);
      expect(r?.modelId).toBe("some-model");
    }
  });

  it("falls back to the catch-all with the WHOLE string preserved", () => {
    const r = resolveRoute(cfg, "some-vendor/some-model");
    expect(r?.provider).toBe(cfg.catchAll);
    // Load-bearing: to the catch-all provider there was never a prefix to strip.
    expect(r?.modelId).toBe("some-vendor/some-model");
  });

  it("sends a bare model to the catch-all unchanged", () => {
    expect(resolveRoute(cfg, "solo-model")?.modelId).toBe("solo-model");
  });

  it("refuses a disabled provider (falls through to catch-all)", () => {
    const c = mk(["parked", "fallback"], {}, "fallback");
    c.providers.parked!.enabled = false;
    expect(resolveRoute(c, "parked/x")?.provider).toBe("fallback");
  });

  it("returns null when there is no catch-all and no match", () => {
    expect(resolveRoute(mk(["a"]), "unknown/x")).toBeNull();
  });

  it("survives an alias cycle instead of hanging", () => {
    const c = mk(["real"], { a: "b", b: "a" }, "real");
    expect(() => resolveRoute(c, "a/x")).not.toThrow();
  });

  it("SHIPPED CONFIG: every provider resolves to itself", () => {
    for (const name of Object.keys(cfg.providers)) {
      expect(resolveRoute(cfg, `${name}/probe`)?.provider, `${name} was shadowed`).toBe(name);
    }
  });

  it("SHIPPED CONFIG: every provider egresses via AI Gateway", () => {
    for (const [name, p] of Object.entries(cfg.providers)) {
      expect(p.slug, `provider ${name} has no slug`).toBeTruthy();
    }
  });

  it("SHIPPED CONFIG: aliases and catchAll point at real providers", () => {
    for (const [a, t] of Object.entries(cfg.aliases ?? {})) {
      expect(cfg.providers[t], `alias ${a} → missing provider ${t}`).toBeTruthy();
    }
    expect(cfg.providers[cfg.catchAll!], "catchAll is not a provider").toBeTruthy();
  });
});

describe("AI Gateway provider slugs", () => {
  const CUSTOM = new Set([
    "custom-nvidia",
    "custom-zai",
    "custom-zai-anthropic",
  ]);
  const NATIVE = new Set(["groq", "openai", "openrouter", "huggingface", "workers-ai", "anthropic"]);
  // Not a provider at all: `compat` is AI Gateway's own unified endpoint, the only way to
  // address a dynamic route. It takes no `custom-` prefix for exactly that reason.
  const ENDPOINTS = new Set(["compat"]);

  it("every provider slug is a known custom or native provider", () => {
    for (const [name, p] of Object.entries(cfg.providers)) {
      expect(
        CUSTOM.has(p.slug) || NATIVE.has(p.slug) || ENDPOINTS.has(p.slug),
        `unknown slug "${p.slug}" on ${name}`,
      ).toBe(true);
    }
  });

  it("custom slugs carry the required `custom-` prefix", () => {
    // AI Gateway rejects a custom provider referenced without it — the registered slug is
    // `zai` but the URL segment must be `custom-zai`.
    for (const s of CUSTOM) expect(s.startsWith("custom-")).toBe(true);
  });
});

describe("outboundModel — keepPrefix (AI Gateway dynamic routes)", () => {
  const cfg = {
    providers: {
      nvidia_nim: { slug: "custom-nvidia" },
      dynamic: { slug: "compat", path: "/chat/completions", keepPrefix: true, keyPool: "nvidia_nim" },
    },
  } as unknown as GatewayConfig;

  it("sends the WHOLE model id upstream, prefix included", () => {
    const r = resolveRoute(cfg, "dynamic/extract-docs")!;
    expect(r.provider).toBe("dynamic");
    // The router still strips, as it must for routing...
    expect(r.modelId).toBe("extract-docs");
    // ...but the id that goes upstream keeps the prefix. Sending the bare route name
    // gets `Chat completion bad format` from AI Gateway.
    expect(outboundModel(r, "dynamic/extract-docs")).toBe("dynamic/extract-docs");
  });

  it("leaves every other provider stripping as before", () => {
    const r = resolveRoute(cfg, "nvidia_nim:deepseek-ai/deepseek-v4-flash")!;
    expect(outboundModel(r, "nvidia_nim:deepseek-ai/deepseek-v4-flash")).toBe("deepseek-ai/deepseek-v4-flash");
  });

  it("a route name containing a slash survives intact", () => {
    const r = resolveRoute(cfg, "dynamic/team/extract-v2")!;
    expect(outboundModel(r, "dynamic/team/extract-v2")).toBe("dynamic/team/extract-v2");
  });
});

describe("resolveRoute — the model id a provider actually receives", () => {
  const c = mk(["myprov"], { mp: "myprov" });

  it("strips any registered prefix or alias, colon or slash form", () => {
    expect(resolveRoute(c, "myprov:model-a")?.modelId).toBe("model-a");
    expect(resolveRoute(c, "mp/model-a")?.modelId).toBe("model-a");
  });

  it("keeps a colon that belongs to the model id after a slash separator", () => {
    expect(resolveRoute(c, "myprov/qwen:7b")?.modelId).toBe("qwen:7b");
  });
});
