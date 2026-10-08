import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { CookieJar } from "../../src/auth/cookie-jar.js";
import type { AuthenticatedSession } from "../../src/auth/auth-adapter.js";
import { UpstreamApiClient } from "../../src/upstream/upstream-client.js";
import type { HttpResponse, HttpTransport } from "../../src/http/http-client.js";

const config = loadConfig({
  UPSTREAM_ENTRY_URL: "https://search.ebscohost.com/login.aspx?profile=example",
  UPSTREAM_PROMPT_VALUE: "synthetic-prompt",
  SESSION_ENCRYPTION_KEY: "a".repeat(64),
  SOURCE_REF_ACTIVE_KEY_ID: "v1",
  SOURCE_REF_KEYS_JSON: JSON.stringify({ v1: "b".repeat(64) }),
});

const session: AuthenticatedSession = {
  source: "server",
  cookieJar: CookieJar.fromSetCookie(["SessionIdentifier=synthetic; Path=/"], 1_700_000_000),
  createdAt: 1_700_000_000,
};

describe("UpstreamApiClient", () => {
  it("preserves the upstream envelope and body array", async () => {
    const fixture = await readFile(new URL("../fixtures/makes-2024.json", import.meta.url), "utf8");
    const transport: HttpTransport = async () => ({ status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(fixture) });
    const client = new UpstreamApiClient(config, transport);

    const result = await client.execute("makes", { year: 2024 }, session);

    expect(result.header.statusCode).toBe(200);
    expect(result.body).toEqual(expect.arrayContaining([{ makeId: 2, makeName: "Porsche" }]));
  });

  it("sends the session cookie and preserves article query parameters", async () => {
    let seen: { url?: string; cookie?: string } = {};
    const transport: HttpTransport = async (request) => {
      seen = { url: request.url, cookie: request.headers?.cookie };
      return { status: 200, headers: { "content-type": "application/json" }, body: Buffer.from('{"header":{"statusCode":200},"body":{}}') };
    };
    const client = new UpstreamApiClient(config, transport);

    await client.execute("article", {
      contentSource: "GeneralMotors", vehicleId: "100342221", articleId: "4481222:17911387",
      bucketName: "Component Location Diagrams", articleSubtype: "", searchTerm: "",
    }, session);

    expect(seen.url).toContain("/article/4481222%3A17911387?");
    expect(seen.url).toContain("bucketName=Component%20Location%20Diagrams");
    expect(seen.cookie).toContain("SessionIdentifier=synthetic");
  });

  it("adopts a renewed upstream session cookie from a successful response", async () => {
    const transport: HttpTransport = async () => ({
      status: 200,
      headers: { "content-type": "application/json", "set-cookie": "SessionIdentifier=renewed; Path=/" },
      body: Buffer.from('{"header":{"statusCode":200},"body":[]}'),
    });
    const client = new UpstreamApiClient(config, transport);

    await client.execute("years", {}, session);

    expect(session.cookieJar.toHeader(1_700_000_000)).toContain("SessionIdentifier=renewed");
  });
});
