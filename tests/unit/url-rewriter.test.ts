import { describe, expect, it } from "vitest";
import { rewriteResources, type ResourceRewriteContext } from "../../src/content/url-rewriter.js";

const context: ResourceRewriteContext = {
  upstreamOrigin: "https://sites.motor.com",
  connectorAssetUrl: ({ kind, id, source }) => `https://connector.test/v1/assets/reference/${kind}/${source ?? "none"}/${id}`,
  allowedExternalOrigins: ["https://cdn.example.com"],
};

describe("resource URL rewriting", () => {
  it("rewrites same-origin assets and preserves allowlisted HTTPS resources", () => {
    const result = rewriteResources(
      '<img src="/m1/api/source/GeneralMotors/graphic/4481151"><img src="https://cdn.example.com/a.png"><a href="javascript:alert(1)">bad</a>',
      context,
    );
    expect(result.html).toContain('src="https://connector.test/v1/assets/reference/graphic/GeneralMotors/4481151"');
    expect(result.html).toContain('src="https://cdn.example.com/a.png"');
    expect(result.html).not.toContain("javascript:");
    expect(result.resources).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: "https://connector.test/v1/assets/reference/graphic/GeneralMotors/4481151", kind: "asset" }),
    ]));
  });

  it("rewrites provider-relative graphic paths and canonicalizes source casing", () => {
    const result = rewriteResources(
      '<img src="api/source/MOTOR/graphic/16619615"><img src="/api/source/Toyota/graphic/diagram%3A2">',
      context,
    );

    expect(result.html).toContain('src="https://connector.test/v1/assets/reference/graphic/Motor/16619615"');
    expect(result.html).toContain('src="https://connector.test/v1/assets/reference/graphic/Toyota/diagram:2"');
    expect(result.resources).toHaveLength(2);
    expect(result.html).not.toContain("sites.motor.com");
  });

  it("does not turn an unknown provider source into an asset reference", () => {
    const result = rewriteResources('<img src="api/source/Unknown/graphic/42">', context);

    expect(result.html).not.toContain("src=");
    expect(result.resources).toEqual([]);
  });

  it("rewrites srcset and removes unsafe CSS URLs", () => {
    const result = rewriteResources(
      '<img srcset="/m1/api/asset/a 1x, /m1/api/asset/b 2x" style="background:url(javascript:alert(1))">',
      context,
    );
    expect(result.html).toContain("https://connector.test/v1/assets/reference/asset/none/a 1x");
    expect(result.html).toContain("https://connector.test/v1/assets/reference/asset/none/b 2x");
    expect(result.html).not.toContain("javascript:");
  });
});
