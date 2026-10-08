import type { FastifyInstance } from "fastify";
import type { OpenAPIV3 } from "openapi-types";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { PUBLIC_API_ROUTES } from "./routes/api-routes.js";
import { UPSTREAM_ROUTES } from "./upstream/route-registry.js";

type ExampleValue = string | boolean;

type ParameterExample = {
  type: "string" | "boolean";
  example: ExampleValue;
  description: string;
};

const PARAMETER_EXAMPLES: Record<string, ParameterExample> = {
  year: { type: "string", example: "2024", description: "Model year." },
  make: { type: "string", example: "Toyota", description: "Vehicle make name." },
  vin: { type: "string", example: "1HGCM82633A004352", description: "Vehicle identification number." },
  catalog: { type: "string", example: "gm", description: "Neutral catalog alias (for example, gm or toyota)." },
  vehicleId: { type: "string", example: "100342221", description: "Provider vehicle identifier." },
  articleId: { type: "string", example: "4481222:17911387", description: "Provider article identifier." },
  id: { type: "string", example: "4481151", description: "Provider graphic identifier." },
  handleId: { type: "string", example: "example-asset-handle", description: "Valid provider asset handle; the displayed placeholder is expected to return 404 until replaced." },
  vehicleIds: { type: "string", example: "100342221", description: "Comma-separated provider vehicle identifiers." },
  bucketName: { type: "string", example: "Component Location Diagrams", description: "Optional provider article bucket." },
  articleSubtype: { type: "string", example: "", description: "Optional provider article subtype." },
  searchTerm: { type: "string", example: "", description: "Optional provider article search term." },
  raw: { type: "boolean", example: false, description: "Return the upstream envelope without HTML normalization." },
};

function routeParameterNames(routeUrl: string): string[] {
  return [...routeUrl.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1]);
}

function openApiParameter(name: string, location: "path" | "query", required: boolean): OpenAPIV3.ParameterObject {
  const definition = PARAMETER_EXAMPLES[name] ?? { type: "string", example: "", description: `Provider ${name} value.` };
  return {
    name,
    in: location,
    required,
    description: definition.description,
    example: definition.example,
    schema: {
      type: definition.type,
      default: definition.example,
      example: definition.example,
    },
  };
}

export async function registerOpenApi(app: FastifyInstance): Promise<void> {
  const openapi = app.swagger?.() as OpenAPIV3.Document | undefined;
  if (!openapi) return;
  openapi.paths ??= {};
  for (const route of PUBLIC_API_ROUTES) {
    const path = route.url.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
    const upstreamRoute = UPSTREAM_ROUTES[route.routeId];
    const parameters = [
      ...routeParameterNames(route.url).map((name) => openApiParameter(name, "path", true)),
      ...route.query.map((name) => openApiParameter(name, "query", false)),
      ...(upstreamRoute.responseKind === "json" ? [openApiParameter("raw", "query", false)] : []),
    ];
    openapi.paths[path] ??= {};
    openapi.paths[path].get = {
      operationId: route.routeId,
      summary: `Read upstream ${route.routeId}`,
      parameters,
      responses: {
        "200": { description: "Upstream response envelope" },
        ...(route.routeId === "parts" ? { "404": { description: "No parts list is available for this vehicle" } } : {}),
        ...(route.routeId === "labor" ? { "404": { description: "No labor data is available for this vehicle or article" } } : {}),
        ...(["maintenanceFrequency", "maintenanceIntervals", "maintenanceIndicators"].includes(route.routeId)
          ? { "404": { description: "No maintenance schedule is available for this vehicle" } }
          : {}),
        ...(route.routeId === "asset" ? { "404": { description: "The requested upstream asset is unavailable or invalid" } } : {}),
        "502": { description: "Upstream failure" },
      },
    };
  }
  const contract = parse(readFileSync(new URL("./source-contract/openapi.yaml", import.meta.url), "utf8")) as OpenAPIV3.Document;
  Object.assign(openapi.paths, contract.paths);
  openapi.components = { ...openapi.components, ...contract.components };
  openapi.servers = contract.servers;
  openapi.openapi = contract.openapi;
  openapi.info.version = contract.info.version;
}
