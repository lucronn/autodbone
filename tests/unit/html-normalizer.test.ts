import { describe, expect, it } from "vitest";
import { normalizeHtml, type HtmlNormalizationContext } from "../../src/content/html-normalizer.js";

const context: HtmlNormalizationContext = {
  publicBaseUrl: "https://connector.test",
  contentSource: "GeneralMotors",
  publicCatalog: "gm",
  vehicleId: "100342221",
  connectorAssetUrl: ({ id, source }) => `https://connector.test/v1/assets/reference/source/${source}/${id}`,
};

describe("Upstream HTML normalizer", () => {
  it("converts provider image tags to ordinary images", () => {
    const result = normalizeHtml("<div><mtr-image id='4481151' height='514' width='580' alt='Diagram'></mtr-image></div>", context);
    expect(result.html).toContain('<img src="https://connector.test/v1/assets/reference/source/GeneralMotors/4481151"');
    expect(result.html).toContain('alt="Diagram"');
    expect(result.html).toContain('height="514"');
  });

  it("preserves relative Bankone figure URLs as normalized connector resources", () => {
    const result = normalizeHtml(
      '<img class="img-thumbnail" src="api/source/MOTOR/graphic/16619615">',
      { ...context, contentSource: "Motor", publicCatalog: "catalog" },
    );

    expect(result.html).toContain(
      'src="https://connector.test/v1/assets/reference/source/Motor/16619615"',
    );
    expect(result.resources).toEqual([
      expect.objectContaining({
        url: "https://connector.test/v1/assets/reference/source/Motor/16619615",
        kind: "asset",
        attribute: "src",
      }),
    ]);
  });

  it("maps embedded link and emphasis tags without executing content", () => {
    const result = normalizeHtml('<p><eplink linkfield="AN" linkkey="4481222">Open</eplink> <emph>bold-ish</emph></p>', context);
    expect(result.html).toContain('<a href="https://connector.test/v1/api/catalog/gm/vehicle/100342221/article/4481222">Open</a>');
    expect(result.html).toContain("<em>bold-ish</em>");
    expect(result.html).not.toContain("eplink");
  });

  it("maps unknown custom elements to normal span/div elements", () => {
    expect(normalizeHtml("<mystery data-x='drop'><b>text</b></mystery>", context).html).toBe("<span><b>text</b></span>");
  });

  it("drops scripts, event handlers, and dangerous attributes", () => {
    const result = normalizeHtml('<script>alert(1)</script><a href="data:text/html,x" onclick="evil()">x</a>', context);
    expect(result.html).not.toContain("alert");
    expect(result.html).not.toContain("onclick");
    expect(result.html).not.toContain("data:text");
  });
});
