import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { CookieJar } from "../../src/auth/cookie-jar.js";
import type { AuthenticatedSession } from "../../src/auth/auth-adapter.js";
import { UpstreamApiClient } from "../../src/upstream/upstream-client.js";
import { createAssetReference } from "../../src/assets/asset-reference.js";
import { AssetProxy } from "../../src/assets/asset-proxy.js";
import type { HttpTransport } from "../../src/http/http-client.js";

const config = loadConfig({
  UPSTREAM_ENTRY_URL: "https://search.ebscohost.com/login.aspx?profile=example",
  UPSTREAM_PROMPT_VALUE: "synthetic-prompt",
  SESSION_ENCRYPTION_KEY: "a".repeat(64),
  SOURCE_REF_ACTIVE_KEY_ID: "v1",
  SOURCE_REF_KEYS_JSON: JSON.stringify({ v1: "b".repeat(64) }),
});
const secret = Buffer.from("asset-proxy-test-secret");
const session: AuthenticatedSession = {
  source: "server",
  cookieJar: CookieJar.fromSetCookie(["SessionIdentifier=synthetic; Path=/"], 1_700_000_000),
  createdAt: 1_700_000_000,
};

describe("AssetProxy", () => {
  it("streams upstream bytes and preserves content type", async () => {
    const transport: HttpTransport = async () => ({
      status: 200,
      headers: { "content-type": "image/svg+xml", "content-length": "6", etag: "synthetic-etag" },
      body: Buffer.from("<svg/>") ,
    });
    const client = new UpstreamApiClient(config, transport);
    const proxy = new AssetProxy(client, config, secret);
    const reference = createAssetReference({ kind: "source", source: "GeneralMotors", id: "4481151" }, secret, Math.floor(Date.now() / 1000));
    const asset = await proxy.stream(reference, session);
    expect(asset.contentType).toBe("image/svg+xml");
    expect(asset.contentLength).toBe(6);
    expect(asset.headers.etag).toBe("synthetic-etag");
    for await (const chunk of asset.body) expect(Buffer.from(chunk)).toEqual(Buffer.from("<svg/>") );
  });
});
