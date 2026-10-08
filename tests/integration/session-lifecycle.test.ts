import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config.js";
import { CookieJar } from "../../src/auth/cookie-jar.js";
import type { AuthAdapter, AuthenticatedSession } from "../../src/auth/auth-adapter.js";
import { SessionManager } from "../../src/auth/session-manager.js";
import { UpstreamApiClient } from "../../src/upstream/upstream-client.js";
import type { HttpResponse, HttpTransport } from "../../src/http/http-client.js";
import { createApp } from "../../src/server.js";

const config = loadConfig({
  UPSTREAM_ENTRY_URL: "https://search.ebscohost.com/login.aspx?profile=example",
  UPSTREAM_PROMPT_VALUE: "synthetic-prompt",
  SESSION_ENCRYPTION_KEY: "a".repeat(64),
  SOURCE_REF_ACTIVE_KEY_ID: "v1",
  SOURCE_REF_KEYS_JSON: JSON.stringify({ v1: "b".repeat(64) }),
  PUBLIC_BASE_URL: "https://connector.test",
});

function session(value: string): AuthenticatedSession {
  return { source: "server", cookieJar: CookieJar.fromSetCookie([`${value}=yes; Path=/`], 1_700_000_000), createdAt: 1_700_000_000 };
}

function years(status = 200): HttpResponse {
  return { status, headers: { "content-type": "application/json" }, body: Buffer.from(status === 200 ? '{"header":{"statusCode":200},"body":[]}' : "") };
}

function store(initial?: AuthenticatedSession) {
  let value = initial;
  return {
    load: vi.fn(async () => value),
    save: vi.fn(async (next: AuthenticatedSession) => { value = next; }),
  };
}

describe("session lifecycle", () => {
  it("loads an encrypted-session equivalent after a process restart without authenticating again", async () => {
    const persisted = store();
    const firstAuth = vi.fn(async () => session("First"));
    const firstAdapter: AuthAdapter = { authenticate: firstAuth, validate: vi.fn(async () => ({ valid: true as const })) };
    const firstManager = new SessionManager(firstAdapter, persisted, { refreshSkewSeconds: 300 });
    const firstApp = await createApp({ config, upstreamClient: new UpstreamApiClient(config, async () => years()), sessionManager: firstManager });
    expect((await firstApp.inject({ method: "GET", url: "/v1/api/years" })).statusCode).toBe(200);
    await firstApp.close();

    const secondAuth = vi.fn(async () => session("Second"));
    const secondAdapter: AuthAdapter = { authenticate: secondAuth, validate: vi.fn(async () => ({ valid: true as const })) };
    const secondManager = new SessionManager(secondAdapter, persisted, { refreshSkewSeconds: 300 });
    const secondApp = await createApp({ config, upstreamClient: new UpstreamApiClient(config, async () => years()), sessionManager: secondManager });
    expect((await secondApp.inject({ method: "GET", url: "/v1/api/years" })).statusCode).toBe(200);
    expect(secondAuth).not.toHaveBeenCalled();
    await secondApp.close();
  });

  it("refreshes once after an upstream unauthorized signal", async () => {
    const persisted = store(session("Persisted"));
    const authenticate = vi.fn(async () => session("Refreshed"));
    const adapter: AuthAdapter = { authenticate, validate: vi.fn(async () => ({ valid: true as const })) };
    const responses = [years(401), years(200)];
    const transport: HttpTransport = async () => responses.shift() ?? years(200);
    const app = await createApp({ config, upstreamClient: new UpstreamApiClient(config, transport), sessionManager: new SessionManager(adapter, persisted, { refreshSkewSeconds: 300 }) });
    expect((await app.inject({ method: "GET", url: "/v1/api/years" })).statusCode).toBe(200);
    expect(authenticate).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("does not persist request-scoped cookie overrides", async () => {
    const persisted = store();
    const adapter: AuthAdapter = { authenticate: vi.fn(async () => session("Server")), validate: vi.fn(async () => ({ valid: true as const })) };
    const app = await createApp({ config, upstreamClient: new UpstreamApiClient(config, async () => years()), sessionManager: new SessionManager(adapter, persisted, { refreshSkewSeconds: 300 }) });
    expect((await app.inject({ method: "GET", url: "/v1/api/years", headers: { "x-upstream-cookie": "Override=yes" } })).statusCode).toBe(200);
    expect(persisted.save).not.toHaveBeenCalled();
    await app.close();
  });

  it("persists a renewed server session cookie returned by UPSTREAM", async () => {
    const persisted = store(session("Persisted"));
    const adapter: AuthAdapter = { authenticate: vi.fn(async () => session("Fresh")), validate: vi.fn(async () => ({ valid: true as const })) };
    const app = await createApp({
      config,
      upstreamClient: new UpstreamApiClient(config, async () => ({
        status: 200,
        headers: { "content-type": "application/json", "set-cookie": "Renewed=yes; Path=/" },
        body: Buffer.from('{"header":{"statusCode":200},"body":[]}'),
      })),
      sessionManager: new SessionManager(adapter, persisted, { refreshSkewSeconds: 300 }),
    });

    expect((await app.inject({ method: "GET", url: "/v1/api/years" })).statusCode).toBe(200);
    expect(persisted.save).toHaveBeenCalledWith(expect.objectContaining({
      cookieJar: expect.objectContaining({}),
    }));
    const saved = await persisted.load();
    expect(saved?.cookieJar.toHeader(1_700_000_000)).toContain("Renewed=yes");
    await app.close();
  });
});
