import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ConnectorError } from "../errors.js";
import type { ApiRouteDependencies } from "../routes/api-routes.js";
import type { UpstreamRouteId, UpstreamRouteParams } from "../upstream/route-registry.js";
import type { UpstreamEnvelope } from "../upstream/upstream-client.js";
import { articleRows, chooseCatalog, matchesMake, matchesModel, modelVehicleIds, normalizeLabel, reportedArticleCount, requireEnvelope, rows, sha256, sourceRevision, textField } from "./projections.js";
import { decodeReference, encodeReference, type SourceReference } from "./references.js";
import { normalizeHtml } from "../content/html-normalizer.js";

const PAGE_SIZE = 100;
type RecordValue = Record<string, unknown>;
type SourceContext = { requestId: string; request: FastifyRequest; reply: FastifyReply; deps: ApiRouteDependencies };
type Fetched = { envelope: UpstreamEnvelope<unknown>; bytes: Buffer };

function fail(code: string, message: string, status: number, retryable = false): never {
  throw Object.assign(new Error(message), { sourceCode: code, status, retryable });
}
function string(value: unknown, name: string, max = 512, required = true): string {
  if (value === undefined || value === null || value === "") {
    if (required) fail("INVALID_INPUT", `${name} is required`, 400);
    return "";
  }
  if (typeof value !== "string" || value.length > max || /[\r\n\0]/.test(value)) fail("INVALID_INPUT", `${name} is invalid`, 400);
  const trimmed = value.trim();
  if (required && !trimmed) fail("INVALID_INPUT", `${name} is required`, 400);
  return trimmed;
}
function year(value: unknown): number {
  const result = Number(value);
  if (!Number.isInteger(result) || result < 1886 || result > 2200) fail("INVALID_INPUT", "year is invalid", 400);
  return result;
}
function onlyKeys(value: RecordValue, keys: readonly string[]): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail("INVALID_INPUT", `Unsupported parameter: ${key}`, 400);
}
function envelope(ctx: SourceContext, revisions: Buffer[], locator: string) {
  return {
    request_id: ctx.requestId,
    provider: "bankone" as const,
    source_revision: sourceRevision(Buffer.concat(revisions)),
    fetched_at: new Date().toISOString(),
    source_locator: `bankone:${locator}`,
  };
}
function resourceHeaders(ctx: SourceContext, metadata: ReturnType<typeof envelope>, contentHash: string, mediaType: string): void {
  ctx.reply.header("x-provider", metadata.provider);
  ctx.reply.header("x-source-revision", metadata.source_revision);
  ctx.reply.header("x-fetched-at", metadata.fetched_at);
  ctx.reply.header("x-source-locator", metadata.source_locator);
  ctx.reply.header("x-source-sha256", contentHash);
  ctx.reply.header("x-source-media-type", mediaType);
}
function publicBaseUrl(ctx: SourceContext): string {
  return ctx.deps.config.publicBaseUrl ?? `${ctx.request.protocol}://${ctx.request.hostname}`;
}
function locator(route: string, params: RecordValue): string {
  return `${route}:${sha256(Buffer.from(JSON.stringify(params))).slice(0, 24)}`;
}
async function fetchSource(ctx: SourceContext, routeId: UpstreamRouteId, params: UpstreamRouteParams): Promise<Fetched> {
  const admission = ctx.deps.clientRateLimiter.check(ctx.request.ip || "unknown");
  if (!admission.allowed) {
    ctx.reply.header("retry-after", String(admission.retryAfterSeconds));
    fail("RATE_LIMITED", "Caller request rate exceeded", 429, true);
  }
  const load = () => ctx.deps.sessionManager.withSession((session) => ctx.deps.upstreamClient.executeResponse(routeId, params, session));
  const key = `source-v1:${routeId}:${JSON.stringify(params)}`;
  const response = await ctx.deps.responseCache.getOrSet(key, 15 * 60, load);
  if (response.status === 401 || response.status === 403) fail("UNAUTHORIZED", "Upstream authorization failed", 502, true);
  if (response.status === 404) fail("NOT_FOUND", "Source resource was not found", 404);
  if (response.status < 200 || response.status >= 300) fail("UPSTREAM_UNAVAILABLE", "Upstream request failed", 502, true);
  let parsed: unknown;
  try { parsed = JSON.parse(response.body.toString("utf8")); }
  catch { fail("INVALID_UPSTREAM_RESPONSE", "Upstream returned invalid JSON", 502); }
  try { return { envelope: requireEnvelope(parsed), bytes: response.body }; }
  catch { fail("INVALID_UPSTREAM_RESPONSE", "Upstream returned an invalid response", 502); }
}
async function fetchBytes(ctx: SourceContext, routeId: UpstreamRouteId, params: UpstreamRouteParams) {
  const admission = ctx.deps.clientRateLimiter.check(ctx.request.ip || "unknown");
  if (!admission.allowed) fail("RATE_LIMITED", "Caller request rate exceeded", 429, true);
  const response = await ctx.deps.sessionManager.withSession((session) => ctx.deps.upstreamClient.executeResponse(routeId, params, session, ctx.deps.config.limits.maxAssetBytes));
  if (response.status === 404) fail("NOT_FOUND", "Source resource was not found", 404);
  if (response.status < 200 || response.status >= 300) fail("UPSTREAM_UNAVAILABLE", "Upstream request failed", 502, true);
  return response;
}
function page<T>(ctx: SourceContext, values: T[], scope: string, filter: string, cursor: unknown, revision: string) {
  const filterHash = sha256(Buffer.from(filter));
  let offset = 0;
  if (cursor !== undefined) {
    const ref = decodeReference(string(cursor, "cursor"), ctx.deps.config.sourceRefs, "cursor");
    if (ref.scope !== scope || ref.filter !== filterHash || !Number.isSafeInteger(ref.offset) || (ref.offset ?? -1) < 0) fail("INVALID_INPUT", "cursor does not match request", 400);
    if (ref.revision !== revision) fail("INVALID_INPUT", "Source changed; restart pagination", 409);
    offset = ref.offset!;
  }
  if (offset > values.length) fail("INVALID_INPUT", "cursor is out of range", 400);
  const items = values.slice(offset, offset + PAGE_SIZE);
  const next = offset + items.length < values.length ? encodeReference({ kind: "cursor", scope, filter: filterHash, offset: offset + items.length, revision }, ctx.deps.config.sourceRefs) : undefined;
  return { items, complete: next === undefined, ...(next ? { next_cursor: next } : {}) };
}
function sourceError(error: unknown, requestId: string) {
  const object = error as { sourceCode?: string; status?: number; retryable?: boolean; code?: string };
  if (object.sourceCode) return { status: object.status ?? 500, body: { request_id: requestId, error: { code: object.sourceCode, message: (error as Error).message, retryable: !!object.retryable } } };
  if (error instanceof ConnectorError) {
    const code = error.code === "invalid_request" || error.code === "invalid_asset_reference" ? "INVALID_INPUT" : error.code === "client_rate_limited" ? "RATE_LIMITED" : error.code === "upstream_auth_failed" ? "UNAUTHORIZED" : error.code === "upstream_timeout" ? "UPSTREAM_UNAVAILABLE" : "UPSTREAM_UNAVAILABLE";
    return { status: error.status, body: { request_id: requestId, error: { code, message: error.message, retryable: ["RATE_LIMITED", "UPSTREAM_UNAVAILABLE"].includes(code) } } };
  }
  return { status: 500, body: { request_id: requestId, error: { code: "UPSTREAM_UNAVAILABLE", message: "Source request failed", retryable: true } } };
}
function register(app: FastifyInstance, method: "get" | "post", url: string, deps: ApiRouteDependencies, handle: (ctx: SourceContext) => Promise<unknown>) {
  app[method](url, async (request, reply) => {
    const requestId = randomUUID();
    reply.header("x-request-id", requestId);
    const ctx = { requestId, request, reply, deps };
    try { return await handle(ctx); }
    catch (error) { const result = sourceError(error, requestId); return reply.code(result.status).send(result.body); }
  });
}
async function matchingModels(ctx: SourceContext, selector: { year: number; make: string; model: string; vin?: string }) {
  const makes = await fetchSource(ctx, "makes", { year: selector.year });
  const selectedMake = rows(makes.envelope).find((item) => matchesMake(textField(item, "makeName", "name", "make"), selector.make));
  if (!selectedMake) return { sources: [makes.bytes], catalog: chooseCatalog(selector.make, ctx.deps.config.upstream.allowedContentSources), vehicles: [] as RecordValue[] };
  const make = textField(selectedMake, "makeName", "name", "make");
  const models = await fetchSource(ctx, "models", { year: selector.year, make });
  const ids = [...new Set(rows(models.envelope).filter((item) => matchesModel(textField(item, "modelName", "model", "name", "vehicleModel"), selector.model)).flatMap(modelVehicleIds))];
  if (ids.length > 200) fail("INVALID_UPSTREAM_RESPONSE", "Vehicle selection exceeds the supported bound", 502);
  const catalog = chooseCatalog(make, ctx.deps.config.upstream.allowedContentSources);
  if (!ids.length) return { sources: [makes.bytes, models.bytes], catalog, vehicles: [] as RecordValue[] };
  const vehicles = await fetchSource(ctx, "vehicles", { contentSource: catalog, vehicleIds: ids.join(",") });
  const sources = [makes.bytes, models.bytes, vehicles.bytes];
  let resolved = rows(vehicles.envelope);
  if (selector.vin) {
    const vin = await fetchSource(ctx, "vinVehicle", { vin: selector.vin });
    sources.push(vin.bytes);
    const body = vin.envelope.body;
    const vinVehicleId = textField(body, "vehicleId", "id", "vehicle_id") || textField(rows(vin.envelope)[0], "vehicleId", "id", "vehicle_id");
    resolved = vinVehicleId ? resolved.filter((vehicle) => textField(vehicle, "vehicleId", "id", "vehicle_id") === vinVehicleId) : [];
  }
  return { sources, catalog, vehicles: resolved };
}

export function registerSourceContractRoutes(app: FastifyInstance, deps: ApiRouteDependencies): void {
  register(app, "get", "/v1/capabilities", deps, async (ctx) => ({
    ...envelope(ctx, [Buffer.from("source-contract-v1")], "capabilities"),
    capabilities: ["catalog", "vehicle_resolution", "article_list", "article_search", "resource_read"],
  }));

  register(app, "get", "/v1/catalog/:scope", deps, async (ctx) => {
    const { scope } = ctx.request.params as { scope: string };
    if (!["years", "makes", "models", "configurations"].includes(scope)) fail("INVALID_INPUT", "Unsupported catalog scope", 400);
    const query = ctx.request.query as RecordValue;
    onlyKeys(query, ["year", "make", "model", "cursor"]);
    const requestedYear = scope === "years" ? undefined : year(query.year);
    const requestedMake = scope === "models" || scope === "configurations" ? string(query.make, "make", 160) : undefined;
    const requestedModel = scope === "configurations" ? string(query.model, "model", 160) : undefined;
    const filter = JSON.stringify({ year: requestedYear, make: requestedMake, model: requestedModel });
    let items: RecordValue[];
    let revisions: Buffer[];
    if (scope === "years") {
      const result = await fetchSource(ctx, "years", {});
      revisions = [result.bytes];
      const body = result.envelope.body;
      const values = Array.isArray(body) ? body : rows(result.envelope);
      items = values.map((value) => {
        const resolvedYear = typeof value === "number" || typeof value === "string" ? Number(value) : Number(textField(value, "year", "modelYear", "value"));
        return Number.isInteger(resolvedYear) ? { opaque_ref: encodeReference({ kind: "cursor", scope: "year", filter: String(resolvedYear), offset: 0 }, deps.config.sourceRefs), label: String(resolvedYear), year: resolvedYear } : null;
      }).filter((value) => value !== null);
    } else if (scope === "makes") {
      const result = await fetchSource(ctx, "makes", { year: requestedYear });
      revisions = [result.bytes];
      items = rows(result.envelope).map((item) => {
        const make = textField(item, "makeName", "name", "make");
        return make ? { opaque_ref: encodeReference({ kind: "cursor", scope: "make", filter: `${requestedYear}:${make}`, offset: 0 }, deps.config.sourceRefs), label: make, year: requestedYear, make } : null;
      }).filter((value) => value !== null);
    } else if (scope === "models") {
      const result = await fetchSource(ctx, "models", { year: requestedYear, make: requestedMake });
      revisions = [result.bytes];
      items = rows(result.envelope).map((item) => {
        const model = textField(item, "modelName", "model", "name");
        return model ? { opaque_ref: encodeReference({ kind: "cursor", scope: "model", filter: `${requestedYear}:${requestedMake}:${model}`, offset: 0 }, deps.config.sourceRefs), label: model, year: requestedYear, make: requestedMake, model } : null;
      }).filter((value) => value !== null);
    } else {
      const result = await matchingModels(ctx, { year: requestedYear!, make: requestedMake!, model: requestedModel! });
      revisions = result.sources;
      items = result.vehicles.map((item) => {
        const vehicleId = textField(item, "vehicleId", "id", "vehicle_id");
        if (!vehicleId) return null;
        const label = textField(item, "vehicleName", "displayName", "name", "modelName") || `${requestedYear} ${requestedMake} ${requestedModel}`;
        const engine = textField(item, "engine", "engineName", "engineDescription");
        const drivetrain = textField(item, "drivetrain", "driveType", "driveTrain");
        const region = textField(item, "region", "market");
        return {
          opaque_ref: encodeReference({ kind: "vehicle", catalog: result.catalog, vehicleId }, deps.config.sourceRefs),
          label: label.slice(0, 512), year: requestedYear, make: requestedMake, model: requestedModel,
          configuration: label.slice(0, 512),
          ...(engine ? { engine: engine.slice(0, 256) } : {}),
          ...(drivetrain ? { drivetrain: drivetrain.slice(0, 128) } : {}),
          ...(region ? { region: region.slice(0, 64) } : {}),
        };
      }).filter((value) => value !== null);
    }
    const pagination = page(ctx, items, scope, filter, query.cursor, sourceRevision(Buffer.concat(revisions)));
    return { ...envelope(ctx, revisions, locator(`catalog:${scope}`, { year: requestedYear, make: requestedMake, model: requestedModel })), scope, items: pagination.items, complete: pagination.complete, ...(pagination.next_cursor ? { next_cursor: pagination.next_cursor } : {}) };
  });

  register(app, "post", "/v1/vehicle-resolutions", deps, async (ctx) => {
    const body = ctx.request.body as RecordValue;
    if (!body || typeof body !== "object" || Array.isArray(body)) fail("INVALID_INPUT", "selector must be an object", 400);
    onlyKeys(body, ["year", "make", "model", "configuration", "region", "vin"]);
    const selector = { year: year(body.year), make: string(body.make, "make", 160), model: string(body.model, "model", 160), ...(body.configuration ? { configuration: string(body.configuration, "configuration") } : {}), ...(body.region ? { region: string(body.region, "region", 64) } : {}), ...(body.vin ? { vin: string(body.vin, "vin", 32) } : {}) };
    const result = await matchingModels(ctx, selector);
    const candidates = result.vehicles.map((item) => {
      const vehicleId = textField(item, "vehicleId", "id", "vehicle_id");
      if (!vehicleId) return null;
      const label = textField(item, "vehicleName", "displayName", "name", "modelName") || `${selector.year} ${selector.make} ${selector.model}`;
      if (selector.configuration && !normalizeLabel(label).includes(normalizeLabel(selector.configuration))) return null;
      return { opaque_ref: encodeReference({ kind: "vehicle", catalog: result.catalog, vehicleId }, deps.config.sourceRefs), label: label.slice(0, 512), confidence: selector.configuration ? 0.95 : 0.8, evidence: [`${selector.year} ${selector.make} ${selector.model}`] };
    }).filter((item): item is NonNullable<typeof item> => item !== null);
    if (candidates.length > 100) fail("INVALID_UPSTREAM_RESPONSE", "Vehicle resolution exceeds the supported bound", 502);
    return { ...envelope(ctx, result.sources, locator("vehicle-resolution", selector)), selector, candidates };
  });

  const articles = async (ctx: SourceContext, search?: string) => {
    const { opaqueRef } = ctx.request.params as { opaqueRef: string };
    const ref = decodeReference(opaqueRef, deps.config.sourceRefs, "vehicle");
    if (!ref.catalog || !ref.vehicleId || !deps.config.upstream.allowedContentSources.includes(ref.catalog)) fail("INVALID_INPUT", "Invalid vehicle reference", 400);
    const query = ctx.request.query as RecordValue;
    if (search === undefined) onlyKeys(query, ["cursor"]);
    const cursor = search === undefined ? query.cursor : (ctx.request.body as RecordValue).cursor;
    const upstream = await fetchSource(ctx, "articles", { contentSource: ref.catalog, vehicleId: ref.vehicleId, ...(search ? { searchTerm: search } : {}) });
    const projected = articleRows(upstream.envelope, ref.catalog, ref.vehicleId, deps.config.sourceRefs);
    const pagination = page(ctx, projected, "articles", `${opaqueRef}:${search ?? ""}`, cursor, sourceRevision(upstream.bytes));
    const upstreamCount = reportedArticleCount(upstream.envelope);
    if (upstreamCount !== undefined && upstreamCount > projected.length && !search) fail("INVALID_UPSTREAM_RESPONSE", "Article index is incomplete", 502);
    const complete = pagination.complete;
    return { ...envelope(ctx, [upstream.bytes], locator("articles", { ref: opaqueRef, search })), articles: pagination.items, complete, ...(pagination.next_cursor ? { next_cursor: pagination.next_cursor } : {}) };
  };
  register(app, "get", "/v1/vehicles/:opaqueRef/articles", deps, (ctx) => articles(ctx));
  register(app, "post", "/v1/vehicles/:opaqueRef/article-search", deps, async (ctx) => {
    const body = ctx.request.body as RecordValue;
    if (!body || typeof body !== "object" || Array.isArray(body)) fail("INVALID_INPUT", "search body must be an object", 400);
    onlyKeys(body, ["query", "cursor"]);
    const search = string(body.query, "query", 512);
    return articles(ctx, search);
  });

  register(app, "get", "/v1/resources/:opaqueRef", deps, async (ctx) => {
    const { opaqueRef } = ctx.request.params as { opaqueRef: string };
    const ref = decodeReference(opaqueRef, deps.config.sourceRefs);
    if (ref.kind === "article" || ref.kind === "labor") {
      if (!ref.catalog || !ref.vehicleId || !ref.articleId || !deps.config.upstream.allowedContentSources.includes(ref.catalog)) fail("INVALID_INPUT", "Invalid resource reference", 400);
      const result = await fetchSource(ctx, ref.kind === "article" ? "article" : "labor", { contentSource: ref.catalog, vehicleId: ref.vehicleId, articleId: ref.articleId });
      const body = result.envelope.body;
      const rawHtml = ref.kind === "article" && typeof (body as RecordValue)?.html === "string" ? String((body as RecordValue).html) : undefined;
      const assetResourceRefs = new Set<string>();
      const baseUrl = publicBaseUrl(ctx);
      if (rawHtml !== undefined) {
        // Scan provider markup inside Bankone to discover resource relationships.
        // The normalized presentation is deliberately discarded: `content` stays raw.
        normalizeHtml(rawHtml, {
          publicBaseUrl: baseUrl,
          contentSource: ref.catalog,
          publicCatalog: ref.catalog,
          vehicleId: ref.vehicleId,
          upstreamOrigin: deps.config.upstream.apiOrigin,
          connectorAssetUrl: (target) => {
            const catalog = target.source ?? ref.catalog!;
            if (!deps.config.upstream.allowedContentSources.includes(catalog)) fail("INVALID_UPSTREAM_RESPONSE", "Article references a disallowed source", 502);
            const assetRef = encodeReference({ kind: "asset", catalog, assetKind: target.kind === "asset" ? "asset" : "graphic", assetId: target.id }, deps.config.sourceRefs);
            assetResourceRefs.add(assetRef);
            return `${baseUrl}/v1/resources/${assetRef}`;
          },
        });
      }
      const content = rawHtml ?? JSON.stringify(body);
      if (content.length > 10_000_000) fail("INVALID_UPSTREAM_RESPONSE", "Source resource is too large", 502);
      const mediaType = rawHtml !== undefined ? "text/html" : "application/json";
      const metadata = envelope(ctx, [result.bytes], locator(ref.kind, { catalog: ref.catalog, vehicleId: ref.vehicleId, articleId: ref.articleId }));
      const contentHash = sha256(Buffer.from(content));
      resourceHeaders(ctx, metadata, contentHash, mediaType);
      return { ...metadata, kind: ref.kind, media_type: mediaType, content, sha256: contentHash, ...(assetResourceRefs.size ? { asset_resource_refs: [...assetResourceRefs] } : {}) };
    }
    if (ref.kind === "asset" && ref.assetId && (ref.assetKind === "graphic" || ref.assetKind === "asset")) {
      if (ref.assetKind === "graphic" && (!ref.catalog || !deps.config.upstream.allowedContentSources.includes(ref.catalog))) fail("INVALID_INPUT", "Invalid asset reference", 400);
      const result = await fetchBytes(ctx, ref.assetKind, ref.assetKind === "graphic" ? { contentSource: ref.catalog, id: ref.assetId } : { handleId: ref.assetId });
      if (result.body.length > 15_000_000) fail("INVALID_UPSTREAM_RESPONSE", "Source asset exceeds the contract size limit", 502);
      const mediaType = String(result.headers["content-type"] ?? "application/octet-stream").split(";")[0].slice(0, 128);
      const metadata = envelope(ctx, [result.body], locator("asset", { kind: ref.assetKind, id: ref.assetId }));
      const contentHash = sha256(result.body);
      resourceHeaders(ctx, metadata, contentHash, mediaType);
      const accept = String(ctx.request.headers.accept ?? "");
      if (accept.split(",").some((value) => value.trim().split(";")[0] === "application/octet-stream")) {
        return ctx.reply.type("application/octet-stream").send(result.body);
      }
      return { ...metadata, kind: "asset", media_type: mediaType, content_base64: result.body.toString("base64"), sha256: contentHash };
    }
    fail("INVALID_INPUT", "Invalid resource reference", 400);
  });
}
