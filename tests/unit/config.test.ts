import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";

const validEnv = {
  UPSTREAM_ENTRY_URL: "https://search.ebscohost.com/login.aspx?profile=example",
  UPSTREAM_PROMPT_VALUE: "example-prompt",
  SESSION_ENCRYPTION_KEY: "a".repeat(64),
  SOURCE_REF_ACTIVE_KEY_ID: "v1",
  SOURCE_REF_KEYS_JSON: JSON.stringify({ v1: "b".repeat(64) }),
};

describe("loadConfig", () => {
  it("requires runtime-managed upstream credentials", () => {
    expect(() => loadConfig({ SESSION_ENCRYPTION_KEY: "a".repeat(64) })).toThrow(/UPSTREAM_ENTRY_URL/);
    expect(() => loadConfig({ ...validEnv, UPSTREAM_PROMPT_VALUE: "" })).toThrow(/UPSTREAM_PROMPT_VALUE/);
  });

  it("loads a server session configuration without exposing secret values", () => {
    const config = loadConfig(validEnv);

    expect(config.upstream.entryUrl).toContain("search.ebscohost.com");
    expect(config.session.encryptionKey).toHaveLength(32);
    expect(config.session.encryptionKey.toString("hex")).toBe("a".repeat(64));
    expect(config.upstream.promptValue).toBe("example-prompt");
    expect(config.sourceRefs.activeKeyId).toBe("v1");
    expect(config.sourceRefs.keys.v1).toHaveLength(32);
  });

  it("keeps source-reference keys independent of the session key", () => {
    expect(() => loadConfig({ ...validEnv, SOURCE_REF_KEYS_JSON: JSON.stringify({ v1: "a".repeat(64) }) })).toThrow(/separate/);
    expect(() => loadConfig({ ...validEnv, SOURCE_REF_ACTIVE_KEY_ID: "v2" })).toThrow(/must exist/);
  });

  it("rejects a non-HTTPS upstream origin", () => {
    expect(() => loadConfig({ ...validEnv, UPSTREAM_API_ORIGIN: "http://evil.test" })).toThrow(/HTTPS/);
  });

  it("uses safe defaults for optional limits", () => {
    const config = loadConfig(validEnv);

    expect(config.limits.requestTimeoutMs).toBe(15_000);
    expect(config.limits.maxResponseBytes).toBe(8 * 1024 * 1024);
    expect(config.limits.maxClientRequestsPerWindow).toBe(60);
    expect(config.limits.clientRateWindowSeconds).toBe(60);
    expect(config.limits.responseCacheMaxEntries).toBe(512);
    expect(config.limits.responseCacheMaxBytes).toBe(64 * 1024 * 1024);
    expect(config.session.refreshSkewSeconds).toBe(300);
  });
});
