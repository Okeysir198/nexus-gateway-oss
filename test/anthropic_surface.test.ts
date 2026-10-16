import { describe, expect, it } from "vitest";
import { anthropicHeaders, anthropicSurface, normalizeModels, stripAnthropicPrefix } from "../src/upstream/anthropic";
import type { Env } from "../src/types";

/** The native-Anthropic passthrough gates on PATH alone, so the path classifier is the
 *  security boundary: it must keep the Admin API out and let everything else through. */

describe("anthropicSurface", () => {
  it("claims the siblings of /v1/messages on the root", () => {
    for (const p of ["/v1/messages/count_tokens", "/v1/messages/batches", "/v1/messages/batches/msgbatch_1/results"]) {
      expect(anthropicSurface(p)).toEqual({ upstreamPath: p, prefixed: false });
    }
  });

  it("does not claim chat, models or files on the root", () => {
    for (const p of ["/v1/messages", "/v1/models", "/v1/files", "/v1/chat/completions", "/health"]) {
      expect(anthropicSurface(p)).toBeNull();
    }
  });

  it("passes any /anthropic/v1/* path, stripping only the prefix", () => {
    for (const p of ["/v1/messages", "/v1/files/file_1/content", "/v1/models", "/v1/skills", "/v1/agents"]) {
      expect(anthropicSurface("/anthropic" + p)).toEqual({ upstreamPath: p, prefixed: true });
    }
  });

  it("denies the Admin API and OAuth, including percent-encoded spellings", () => {
    for (const p of [
      "/anthropic/v1/organizations/workspaces",
      "/anthropic/v1/%6Frganizations/api_keys",
      "/anthropic/v1/oauth/token",
    ]) {
      expect(anthropicSurface(p)).toHaveProperty("denied");
    }
  });

  it("denies paths outside /v1 and traversal attempts under the prefix", () => {
    for (const p of ["/anthropic/other", "/anthropic/v1/..%2Forganizations", "/anthropic/v1/a\\b", "/anthropic/%E0%A4%A"]) {
      expect(anthropicSurface(p)).toHaveProperty("denied");
    }
  });
});

describe("normalizeModels", () => {
  it("strips the provider prefix from a messages / count_tokens body", () => {
    expect(JSON.parse(normalizeModels('{"model":"anthropic/claude-haiku-5-5","max_tokens":1}')).model).toBe("claude-haiku-5-5");
    expect(JSON.parse(normalizeModels('{"model":"anthropic:claude-haiku-5-5"}')).model).toBe("claude-haiku-5-5");
  });

  it("strips it inside every request of a batch", () => {
    const out = JSON.parse(
      normalizeModels('{"requests":[{"custom_id":"a","params":{"model":"anthropic/claude-haiku-5-5"}},{"custom_id":"b","params":{"model":"claude-opus-5-5"}}]}'),
    );
    expect(out.requests.map((r: { params: { model: string } }) => r.params.model)).toEqual(["claude-haiku-5-5", "claude-opus-5-5"]);
  });

  it("returns the original text untouched when nothing changes or it is not JSON", () => {
    const bare = '{"model":"claude-haiku-5-5"}';
    expect(normalizeModels(bare)).toBe(bare);
    expect(normalizeModels("not json")).toBe("not json");
    expect(normalizeModels("null")).toBe("null");
  });

  it("only strips the anthropic prefix", () => {
    expect(stripAnthropicPrefix("zai_anthropic/glm-4.6")).toBe("zai_anthropic/glm-4.6");
    expect(stripAnthropicPrefix("claude-haiku-5-5")).toBe("claude-haiku-5-5");
  });
});

describe("anthropicHeaders", () => {
  const env = { ANTHROPIC_WORKSPACE_ID: "wrkspc_1" } as unknown as Env;

  it("defaults anthropic-version and forwards anthropic-beta", () => {
    const h = anthropicHeaders({} as Env, new Headers({ "anthropic-beta": "files-api-2025-04-14" }));
    expect(h["anthropic-version"]).toBe("2023-06-01");
    expect(h["anthropic-beta"]).toBe("files-api-2025-04-14");
  });

  it("keeps a caller's anthropic-version", () => {
    expect(anthropicHeaders({} as Env, new Headers({ "anthropic-version": "2024-01-01" }))["anthropic-version"]).toBe("2024-01-01");
  });

  it("adds OUR workspace id only when spending OUR key", () => {
    expect(anthropicHeaders(env, new Headers())["anthropic-workspace-id"]).toBe("wrkspc_1");
    expect(anthropicHeaders(env, new Headers(), "sk-ant-theirs")["anthropic-workspace-id"]).toBeUndefined();
  });
});
