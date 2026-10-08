import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { CookieJar } from "../../src/auth/cookie-jar.js";
import type { AuthAdapter, AuthenticatedSession } from "../../src/auth/auth-adapter.js";
import { SessionManager } from "../../src/auth/session-manager.js";
import { UpstreamApiClient } from "../../src/upstream/upstream-client.js";
import type { HttpTransport } from "../../src/http/http-client.js";
import { createApp } from "../../src/server.js";

const config = loadConfig({
  UPSTREAM_ENTRY_URL: "https://search.ebscohost.com/login.aspx?profile=example",
  UPSTREAM_PROMPT_VALUE: "synthetic-prompt",
  SESSION_ENCRYPTION_KEY: "a".repeat(64),
  SOURCE_REF_ACTIVE_KEY_ID: "v1",
  SOURCE_REF_KEYS_JSON: JSON.stringify({ v1: "b".repeat(64) }),
});
const serverSession: AuthenticatedSession = {
  source: "server",
  cookieJar: CookieJar.fromSetCookie(["SessionIdentifier=synthetic; Path=/"], 1_700_000_000),
  createdAt: 1_700_000_000,
};
const adapter: AuthAdapter = { authenticate: async () => serverSession, validate: async () => ({ valid: true }) };
const store = { load: async () => serverSession, save: async () => undefined };
const transport: HttpTransport = async () => ({ status: 200, headers: { "content-type": "application/json" }, body: Buffer.from('{"header":{},"body":[]}') });

describe("security boundaries", () => {
  it("rejects disallowed sources and unsupported query parameters", async () => {
    const app = await createApp({ config, upstreamClient: new UpstreamApiClient(config, transport), sessionManager: new SessionManager(adapter, store, { refreshSkewSeconds: 300 }) });
    expect((await app.inject({ method: "GET", url: "/v1/api/catalog/untrusted/vehicles?vehicleIds=1" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/v1/api/years?arbitrary=http%3A%2F%2F127.0.0.1" })).statusCode).toBe(400);
    await app.close();
  });

  it("does not expose write methods on the public OpenAPI document", async () => {
    const app = await createApp({ config, upstreamClient: new UpstreamApiClient(config, transport), sessionManager: new SessionManager(adapter, store, { refreshSkewSeconds: 300 }) });
    const document = (await app.inject({ method: "GET", url: "/openapi.json" })).json();
    expect(JSON.stringify(document.paths)).not.toMatch(/POST|PUT|PATCH|DELETE/);
    await app.close();
  });
});
