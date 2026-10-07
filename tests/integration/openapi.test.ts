import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { createApp } from "../../src/server.js";

const config = loadConfig({
  UPSTREAM_ENTRY_URL: "https://search.ebscohost.com/login.aspx?profile=example",
  UPSTREAM_PROMPT_VALUE: "synthetic-prompt",
  SESSION_ENCRYPTION_KEY: "a".repeat(64),
  PUBLIC_BASE_URL: "https://connector.test",
});

describe("OpenAPI", () => {
  it("documents public routes without write methods", async () => {
    const app = await createApp({ config });
    const response = await app.inject({ method: "GET", url: "/openapi.json" });
    const document = response.json();
    expect(response.statusCode).toBe(200);
    expect(Object.keys(document.paths)).toContain("/v1/api/year/{year}/makes");
    expect(document.components.securitySchemes.BankoneBearer.scheme).toBe("bearer");
    expect(document.paths["/v1/api/years"].get.security).toEqual([{ BankoneBearer: [] }]);
    expect(JSON.stringify(document.paths)).not.toMatch(/POST|PUT|PATCH|DELETE/);
    expect(JSON.stringify(document.paths)).not.toMatch(/motor/i);
    await app.close();
  });

  it("documents editable path and query examples for Swagger UI", async () => {
    const app = await createApp({ config });
    const response = await app.inject({ method: "GET", url: "/openapi.json" });
    const document = response.json();

    expect(document.paths["/v1/api/catalog/{catalog}/vehicle/{vehicleId}/article/{articleId}"]?.get.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "catalog",
        in: "path",
        required: true,
        example: "gm",
        schema: expect.objectContaining({ type: "string", default: "gm" }),
      }),
      expect.objectContaining({
        name: "vehicleId",
        in: "path",
        required: true,
        example: "100342221",
        schema: expect.objectContaining({ type: "string", default: "100342221" }),
      }),
      expect.objectContaining({
        name: "articleId",
        in: "path",
        required: true,
        example: "4481222:17911387",
        schema: expect.objectContaining({ type: "string", default: "4481222:17911387" }),
      }),
      expect.objectContaining({
        name: "bucketName",
        in: "query",
        required: false,
        example: "Component Location Diagrams",
        schema: expect.objectContaining({ type: "string", default: "Component Location Diagrams" }),
      }),
      expect.objectContaining({
        name: "raw",
        in: "query",
        required: false,
        example: false,
        schema: expect.objectContaining({ type: "boolean", default: false }),
      }),
    ]));
    expect(document.paths["/v1/api/catalog/{catalog}/vehicle/{vehicleId}/labor/{articleId}"].get.responses["404"]).toEqual({
      description: "No labor data is available for this vehicle or article",
    });
    expect(document.paths["/v1/api/catalog/{catalog}/vehicle/{vehicleId}/maintenanceSchedules/frequency"].get.responses["404"]).toEqual({
      description: "No maintenance schedule is available for this vehicle",
    });
    expect(document.paths["/v1/api/asset/{handleId}"].get.responses["404"]).toEqual({
      description: "The requested upstream asset is unavailable or invalid",
    });
    await app.close();
  });
});
