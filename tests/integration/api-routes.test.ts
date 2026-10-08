import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { CookieJar } from "../../src/auth/cookie-jar.js";
import type { AuthAdapter, AuthenticatedSession } from "../../src/auth/auth-adapter.js";
import { SessionManager } from "../../src/auth/session-manager.js";
import { UpstreamApiClient } from "../../src/upstream/upstream-client.js";
import { createAssetReference } from "../../src/assets/asset-reference.js";
import type { HttpTransport } from "../../src/http/http-client.js";
import { createApp } from "../../src/server.js";

const config = loadConfig({
  UPSTREAM_ENTRY_URL: "https://search.ebscohost.com/login.aspx?profile=example",
  UPSTREAM_PROMPT_VALUE: "synthetic-prompt",
  SESSION_ENCRYPTION_KEY: "a".repeat(64),
  SOURCE_REF_ACTIVE_KEY_ID: "v1",
  SOURCE_REF_KEYS_JSON: JSON.stringify({ v1: "b".repeat(64) }),
  PUBLIC_BASE_URL: "https://connector.test",
});
const session: AuthenticatedSession = {
  source: "server",
  cookieJar: CookieJar.fromSetCookie(["SessionIdentifier=synthetic; Path=/"], 1_700_000_000),
  createdAt: 1_700_000_000,
};
const adapter: AuthAdapter = {
  authenticate: async () => session,
  validate: async () => ({ valid: true }),
};
const store = { load: async () => session, save: async () => undefined };

async function fixture(name: string): Promise<string> {
  return readFile(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
}

async function appWithTransport(transport: HttpTransport, appConfig = config) {
  const upstreamClient = new UpstreamApiClient(appConfig, transport);
  const sessionManager = new SessionManager(adapter, store, { refreshSkewSeconds: 300 });
  return createApp({ config: appConfig, upstreamClient, sessionManager });
}

describe("public API routes", () => {
  it("does not expose provider-branded route names", async () => {
    const app = await appWithTransport(async () => ({ status: 200, headers: { "content-type": "application/json" }, body: Buffer.from('{"header":{},"body":[]}') }));
    const response = await app.inject({ method: "GET", url: "/v1/api/source/GeneralMotors/vehicle/100342221/parts" });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("returns the makes envelope through the connector", async () => {
    const responseBody = await fixture("makes-2024.json");
    const app = await appWithTransport(async () => ({ status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(responseBody) }));
    const response = await app.inject({ method: "GET", url: "/v1/api/year/2024/makes" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(JSON.parse(responseBody));
    await app.close();
  });

  it("normalizes article HTML but preserves upstream metadata", async () => {
    const responseBody = await fixture("article-component-location.json");
    const app = await appWithTransport(async () => ({ status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(responseBody) }));
    const response = await app.inject({
      method: "GET",
      url: "/v1/api/catalog/gm/vehicle/100342221/article/4481222%3A17911387?bucketName=Component%20Location%20Diagrams&articleSubtype=&searchTerm=",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().body.html).toContain("<img");
    expect(response.json().body.documentId).toBe("4481222");
    expect(response.json().connector.normalized).toBe(true);
    await app.close();
  });

  it("keeps generated asset URLs HTTPS behind a reverse proxy", async () => {
    const proxyConfig = loadConfig({
      UPSTREAM_ENTRY_URL: "https://search.ebscohost.com/login.aspx?profile=example",
      UPSTREAM_PROMPT_VALUE: "synthetic-prompt",
      SESSION_ENCRYPTION_KEY: "a".repeat(64),
      SOURCE_REF_ACTIVE_KEY_ID: "v1",
      SOURCE_REF_KEYS_JSON: JSON.stringify({ v1: "b".repeat(64) }),
    });
    const responseBody = await fixture("article-component-location.json");
    const app = await appWithTransport(async () => ({ status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(responseBody) }), proxyConfig);
    const response = await app.inject({
      method: "GET",
      url: "/v1/api/catalog/gm/vehicle/100342221/article/4481222%3A17911387",
      headers: { host: "connector.test", "x-forwarded-proto": "https" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().body.html).toMatch(/<img[^>]+src="https:\/\/connector\.test\/v1\/assets\/reference\//);
    await app.close();
  });

  it("accepts generated signed asset references longer than Fastify's default parameter limit", async () => {
    const app = await appWithTransport(async () => ({
      status: 200,
      headers: { "content-type": "image/svg+xml" },
      body: Buffer.from("<svg />"),
    }));
    const reference = createAssetReference(
      { kind: "source", source: "GeneralMotors", id: "4481151" },
      config.session.encryptionKey,
      Math.floor(Date.now() / 1000),
    );

    const response = await app.inject({ method: "GET", url: `/v1/assets/reference/${reference}` });

    expect(reference.length).toBeGreaterThan(100);
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("image/svg+xml");
    await app.close();
  });

  it("returns a distinct unavailable error when the upstream has no parts list", async () => {
    const app = await appWithTransport(async () => ({
      status: 500,
      headers: { "content-type": "application/json" },
      body: Buffer.from('{"error":"parts unavailable"}'),
    }));

    const response = await app.inject({
      method: "GET",
      url: "/v1/api/catalog/gm/vehicle/100342221/parts",
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: {
        code: "parts_unavailable",
        message: "No parts list is available for this vehicle.",
        upstreamStatus: 500,
      },
    });
    await app.close();
  });

  it("returns stable unavailable errors for unsupported vehicle resources", async () => {
    const app = await appWithTransport(async (request) => ({
      status: request.url?.endsWith("/maintenanceSchedules/intervals") || request.url?.endsWith("/asset/example-asset-handle") ? 400 : 500,
      headers: { "content-type": "application/json" },
      body: Buffer.from('{"error":"resource unavailable"}'),
    }));

    const cases = [
      {
        url: "/v1/api/catalog/gm/vehicle/100342221/labor/4481222%3A17911387",
        code: "labor_unavailable",
        message: "No labor data is available for this vehicle or article.",
        upstreamStatus: 500,
      },
      ...["frequency", "intervals", "indicators"].map((schedule) => ({
        url: `/v1/api/catalog/gm/vehicle/100342221/maintenanceSchedules/${schedule}`,
        code: "maintenance_schedule_unavailable",
        message: "No maintenance schedule is available for this vehicle.",
        upstreamStatus: schedule === "intervals" ? 400 : 500,
      })),
      {
        url: "/v1/api/asset/example-asset-handle",
        code: "asset_unavailable",
        message: "The requested upstream asset is unavailable or invalid.",
        upstreamStatus: 400,
      },
    ];

    for (const testCase of cases) {
      const response = await app.inject({ method: "GET", url: testCase.url });
      expect(response.statusCode).toBe(404);
      const { url: _url, ...error } = testCase;
      expect(response.json()).toMatchObject({ error });
    }
    await app.close();
  });

  it("allows a request-scoped upstream cookie without persisting it", async () => {
    let cookie = "";
    const app = await appWithTransport(async (request) => {
      cookie = request.headers?.cookie ?? "";
      return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from('{"header":{},"body":[]}') };
    });
    const response = await app.inject({ method: "GET", url: "/v1/api/years", headers: { "x-upstream-cookie": "Override=synthetic" } });
    expect(response.statusCode).toBe(200);
    expect(cookie).toContain("Override=synthetic");
    await app.close();
  });

  it("serves repeated default-session reads from cache", async () => {
    let upstreamCalls = 0;
    const app = await appWithTransport(async () => {
      upstreamCalls += 1;
      return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from('{"header":{},"body":[]}') };
    });

    expect((await app.inject({ method: "GET", url: "/v1/api/years" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/v1/api/years" })).statusCode).toBe(200);
    expect(upstreamCalls).toBe(1);
    await app.close();
  });

  it("rejects an over-limit caller before the upstream transport and does not allow a bulk flag", async () => {
    let upstreamCalls = 0;
    const limitedConfig = {
      ...config,
      limits: { ...config.limits, maxClientRequestsPerWindow: 1, clientRateWindowSeconds: 60 },
    };
    const app = await createApp({
      config: limitedConfig,
      upstreamClient: new UpstreamApiClient(limitedConfig, async () => {
        upstreamCalls += 1;
        return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from('{"header":{},"body":[]}') };
      }),
      sessionManager: new SessionManager(adapter, store, { refreshSkewSeconds: 300 }),
    });

    expect((await app.inject({ method: "GET", url: "/v1/api/years" })).statusCode).toBe(200);
    const limited = await app.inject({ method: "GET", url: "/v1/api/years" });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toMatchObject({ code: "client_rate_limited" });
    expect(limited.headers["retry-after"]).toBeDefined();
    expect((await app.inject({ method: "GET", url: "/v1/api/years?bulk=1" })).statusCode).toBe(400);
    expect(upstreamCalls).toBe(1);
    await app.close();
  });
});
