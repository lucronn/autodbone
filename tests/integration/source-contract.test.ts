import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CookieJar } from "../../src/auth/cookie-jar.js";
import type { AuthAdapter, AuthenticatedSession } from "../../src/auth/auth-adapter.js";
import { SessionManager } from "../../src/auth/session-manager.js";
import { loadConfig } from "../../src/config.js";
import type { HttpTransport } from "../../src/http/http-client.js";
import { createApp } from "../../src/server.js";
import { encodeReference } from "../../src/source-contract/references.js";
import { UpstreamApiClient } from "../../src/upstream/upstream-client.js";

const config = loadConfig({
  UPSTREAM_ENTRY_URL: "https://search.ebscohost.com/login.aspx?profile=example",
  UPSTREAM_PROMPT_VALUE: "synthetic-prompt",
  SESSION_ENCRYPTION_KEY: "a".repeat(64),
  PUBLIC_BASE_URL: "https://bankone.cars.tk",
});
const session: AuthenticatedSession = {
  source: "server",
  cookieJar: CookieJar.fromSetCookie(["SessionIdentifier=synthetic; Path=/"], 1_700_000_000),
  createdAt: 1_700_000_000,
};
const adapter: AuthAdapter = { authenticate: async () => session, validate: async () => ({ valid: true }) };
const store = { load: async () => session, save: async () => undefined };
function json(body: unknown) {
  return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ header: { statusCode: 200 }, body })) };
}
async function appWithTransport(transport: HttpTransport) {
  return createApp({
    config,
    upstreamClient: new UpstreamApiClient(config, transport),
    sessionManager: new SessionManager(adapter, store, { refreshSkewSeconds: 300 }),
  });
}

describe("Bankone source contract", () => {
  it("resolves ambiguous model trims to stable opaque vehicle references", async () => {
    const paths: string[] = [];
    const app = await appWithTransport(async (request) => {
      paths.push(new URL(request.url).pathname);
      if (request.url.endsWith("/year/2024/makes")) return json([{ makeName: "Toyota" }]);
      if (request.url.endsWith("/year/2024/make/Toyota/models")) return json([{ modelName: "4Runner Base", vehicleIds: ["v1", "v2"] }]);
      if (request.url.includes("/source/Toyota/vehicles")) return json([{ vehicleId: "v1", vehicleName: "4Runner Base" }, { vehicleId: "v2", vehicleName: "4Runner SR5" }]);
      throw new Error(`Unexpected upstream request: ${request.url}`);
    });
    const first = await app.inject({ method: "POST", url: "/v1/vehicle-resolutions", payload: { year: 2024, make: "Toyota", model: "4 Runner 4wd" } });
    const second = await app.inject({ method: "POST", url: "/v1/vehicle-resolutions", payload: { year: 2024, make: "Toyota", model: "4 Runner 4wd" } });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ provider: "bankone", selector: { year: 2024, make: "Toyota", model: "4 Runner 4wd" } });
    expect(first.json().candidates).toHaveLength(2);
    expect(first.json().candidates.map((candidate: { opaque_ref: string }) => candidate.opaque_ref)).toEqual(second.json().candidates.map((candidate: { opaque_ref: string }) => candidate.opaque_ref));
    expect(first.json().candidates[0].opaque_ref).not.toContain("v1");
    expect(paths).toContain("/m1/api/source/Toyota/vehicles");
    await app.close();
  });

  it("paginates catalog data and binds the cursor to its scope", async () => {
    const app = await appWithTransport(async () => json(Array.from({ length: 101 }, (_, year) => 1900 + year)));
    const first = await app.inject({ method: "GET", url: "/v1/catalog/years" });
    expect(first.statusCode).toBe(200);
    expect(first.json().items).toHaveLength(100);
    expect(first.json().complete).toBe(false);
    const next = await app.inject({ method: "GET", url: `/v1/catalog/years?cursor=${encodeURIComponent(first.json().next_cursor)}` });
    expect(next.json().items).toHaveLength(1);
    expect(next.json().complete).toBe(true);
    const wrongScope = await app.inject({ method: "GET", url: `/v1/catalog/makes?year=2024&cursor=${encodeURIComponent(first.json().next_cursor)}` });
    expect(wrongScope.statusCode).toBe(400);
    expect(wrongScope.json().error.code).toBe("INVALID_INPUT");
    await app.close();
  });

  it("projects vehicle articles and returns hashed article, labor, and binary resources", async () => {
    const app = await appWithTransport(async (request) => {
      if (request.url.includes("/articles/v2")) return json({ articleDetails: [{ id: "a1", title: "Water Pump Replacement", bucketName: "Cooling", component: "Pump" }] });
      if (request.url.includes("/article/a1")) return json({ html: "<h1>Water Pump Replacement</h1>" });
      if (request.url.includes("/labor/a1")) return json({ hours: 1.5 });
      if (request.url.includes("/graphic/g1")) return { status: 200, headers: { "content-type": "image/png" }, body: Buffer.from([0, 1, 2]) };
      throw new Error(`Unexpected upstream request: ${request.url}`);
    });
    const vehicleRef = encodeReference({ kind: "vehicle", catalog: "Toyota", vehicleId: "v1" }, config.session.encryptionKey);
    const list = await app.inject({ method: "GET", url: `/v1/vehicles/${vehicleRef}/articles` });
    expect(list.statusCode).toBe(200);
    expect(list.json().articles).toHaveLength(1);
    const article = list.json().articles[0];
    const search = await app.inject({ method: "POST", url: `/v1/vehicles/${vehicleRef}/article-search`, payload: { query: "water pump" } });
    expect(search.statusCode).toBe(200);
    expect(search.json().articles[0].opaque_ref).toBe(article.opaque_ref);
    const body = await app.inject({ method: "GET", url: `/v1/resources/${article.resource_ref}` });
    expect(body.statusCode).toBe(200);
    expect(body.json().content).toBe("<h1>Water Pump Replacement</h1>");
    expect(body.json().sha256).toBe(createHash("sha256").update(body.json().content).digest("hex"));
    const labor = await app.inject({ method: "GET", url: `/v1/resources/${article.labor_resource_ref}` });
    expect(labor.json().kind).toBe("labor");
    const assetRef = encodeReference({ kind: "asset", catalog: "Toyota", assetKind: "graphic", assetId: "g1" }, config.session.encryptionKey);
    const asset = await app.inject({ method: "GET", url: `/v1/resources/${assetRef}` });
    expect(asset.json()).toMatchObject({ kind: "asset", media_type: "image/png", content_base64: "AAEC" });
    expect(asset.json().sha256).toBe(createHash("sha256").update(Buffer.from([0, 1, 2])).digest("hex"));
    await app.close();
  });

  it("rejects forged references before using an upstream session", async () => {
    let calls = 0;
    const app = await appWithTransport(async () => { calls += 1; return json([]); });
    const response = await app.inject({ method: "GET", url: "/v1/vehicles/b1.invalid/articles" });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "INVALID_INPUT", retryable: false } });
    expect(calls).toBe(0);
    await app.close();
  });
});
