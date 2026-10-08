import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { CookieJar } from "../../src/auth/cookie-jar.js";
import { EbscoHttpAuthAdapter } from "../../src/auth/ebsco-http-auth-adapter.js";
import type { HttpResponse, HttpTransport } from "../../src/http/http-client.js";

const config = loadConfig({
  UPSTREAM_ENTRY_URL: "https://search.ebscohost.com/login.aspx?profile=example",
  UPSTREAM_PROMPT_VALUE: "synthetic-prompt",
  UPSTREAM_API_ORIGIN: "https://sites.motor.com",
  UPSTREAM_LOGIN_ORIGIN: "https://login.ebsco.com",
  SESSION_ENCRYPTION_KEY: "a".repeat(64),
  SOURCE_REF_ACTIVE_KEY_ID: "v1",
  SOURCE_REF_KEYS_JSON: JSON.stringify({ v1: "b".repeat(64) }),
});

const response = (status: number, body: string, headers: Record<string, string | string[]> = {}): HttpResponse => ({
  status,
  headers,
  body: Buffer.from(body),
});

function sequenceTransport(responses: HttpResponse[]): { transport: HttpTransport; requests: Array<{ url: string; method: string; body?: string }> } {
  const requests: Array<{ url: string; method: string; body?: string }> = [];
  let index = 0;
  return {
    requests,
    transport: async (request) => {
      requests.push({ url: request.url, method: request.method, body: request.body?.toString() });
      const next = responses[index++];
      if (!next) throw new Error("unexpected request");
      return next;
    },
  };
}

describe("EbscoHttpAuthAdapter", () => {
  it("follows prompted login state without a browser", async () => {
    const loginPage = await readFile(new URL("../fixtures/ebsco-login-page.html", import.meta.url), "utf8");
    const authResponse = await readFile(new URL("../fixtures/ebsco-auth-authorized.json", import.meta.url), "utf8");
    const fake = sequenceTransport([
      response(302, "", { location: "https://login.ebsco.com/prompt", "set-cookie": "authContext=synthetic-context; Path=/" }),
      response(200, loginPage, { "set-cookie": "reqId=synthetic-request; Path=/" }),
      response(200, authResponse, { "set-cookie": "AuthUserInfo=synthetic-user; Path=/" }),
      response(302, "", { location: "https://sites.motor.com/m1/vehicles" }),
      response(404, "<html>vehicle app moved</html>"),
      response(200, JSON.stringify({ header: { statusCode: 200 }, body: [1985, 2024] }), { "content-type": "application/json" }),
    ]);
    const adapter = new EbscoHttpAuthAdapter(config, fake.transport);

    const session = await adapter.authenticate();

    expect(session.source).toBe("server");
    expect(session.cookieJar.toHeader(Math.floor(Date.now() / 1000))).toContain("AuthUserInfo=synthetic-user");
    expect(fake.requests.map(({ method, url }) => [method, url])).toEqual([
      ["GET", config.upstream.entryUrl],
      ["GET", "https://login.ebsco.com/prompt"],
      ["POST", "https://login.ebsco.com/api/login/v1/prompted/next-step"],
      ["GET", "https://search.ebscohost.com/webauth/PromptedCallback.aspx?code=fixture-code&state=fixture-state"],
      ["GET", "https://sites.motor.com/m1/vehicles"],
      ["GET", "https://sites.motor.com/m1/api/years"],
    ]);
    const payload = JSON.parse(fake.requests[2].body ?? "{}");
    expect(payload.action).toBe("signin");
    expect(payload.values.prompt).toBe("synthetic-prompt");
    expect(payload.context.original.authRequest).toBe("synthetic-auth-request");
  });

  it("reports invalid when the read-only upstream probe returns 401", async () => {
    const fake = sequenceTransport([response(401, "unauthorized")]);
    const adapter = new EbscoHttpAuthAdapter(config, fake.transport);
    const result = await adapter.validate({
      source: "server",
      createdAt: Math.floor(Date.now() / 1000),
      cookieJar: CookieJar.fromSetCookie(["SessionIdentifier=synthetic; Path=/"], Math.floor(Date.now() / 1000)),
    });

    expect(result).toEqual({ valid: false, reason: "unauthorized" });
  });
});
