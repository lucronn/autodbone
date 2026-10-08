import { createHash } from "node:crypto";
import { ConnectorError } from "../errors.js";
import type { UpstreamEnvelope } from "../upstream/upstream-client.js";
import { encodeReference, type SourceReference } from "./references.js";

type RecordValue = Record<string, unknown>;
const asRecord = (value: unknown): RecordValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
export const textField = (value: unknown, ...keys: string[]): string => {
  const record = asRecord(value);
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return "";
};
export const rows = (value: unknown): RecordValue[] => {
  const body = asRecord(value).body ?? value;
  if (Array.isArray(body)) return body.map(asRecord).filter((item) => Object.keys(item).length > 0);
  for (const key of ["articleDetails", "vehicles", "models", "makes", "years", "items", "results", "records", "rows"]) {
    const values = asRecord(body)[key];
    if (Array.isArray(values)) return values.map(asRecord).filter((item) => Object.keys(item).length > 0);
  }
  return [];
};
export function modelVehicleIds(value: unknown): string[] {
  const model = asRecord(value);
  const values = model.vehicleIds ?? model.vehicle_ids;
  if (Array.isArray(values)) return values.map(String).filter(Boolean);
  if (Array.isArray(model.vehicles)) return model.vehicles.flatMap(modelVehicleIds);
  if (Array.isArray(model.engines)) return model.engines.map((engine) => textField(engine, "id")).filter(Boolean);
  const single = textField(model, "vehicleId", "vehicle_id", "id", "modelId", "model_id");
  return single ? [single] : [];
}
export const normalizeLabel = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "");
export function matchesMake(candidate: string, requested: string): boolean {
  const aliases: Record<string, string> = { chevy: "chevrolet", chevytruck: "chevrolet", chevrolettruck: "chevrolet", fordtruck: "ford", gmctruck: "gmc", toyotatruck: "toyota" };
  const left = normalizeLabel(candidate);
  const right = normalizeLabel(requested);
  return (aliases[left] ?? left).replace(/truck$/, "") === (aliases[right] ?? right).replace(/truck$/, "");
}
export function matchesModel(candidate: string, requested: string): boolean {
  const left = normalizeLabel(candidate);
  const right = normalizeLabel(requested).replace(/(?:2wd|4wd|awd|fwd|rwd)$/, "");
  return !!left && !!right && (left.startsWith(right) || right.startsWith(left));
}
export function chooseCatalog(make: string, allowed: readonly string[]): string {
  const normalized = normalizeLabel(make);
  const preferred = normalized === "toyota" ? "Toyota" : ["chevrolet", "chevy", "gmc", "buick", "cadillac"].includes(normalized) ? "GeneralMotors" : "Motor";
  return allowed.includes(preferred) ? preferred : allowed[0];
}
export function requireEnvelope(value: unknown): UpstreamEnvelope<unknown> {
  const record = asRecord(value);
  if (!("header" in record) || !("body" in record)) throw new ConnectorError("upstream_error", "Invalid upstream response", 502);
  return record as UpstreamEnvelope<unknown>;
}
export function articleRows(envelope: UpstreamEnvelope<unknown>, catalog: string, vehicleId: string, key: Buffer) {
  return rows(envelope).map((item) => {
    const articleId = textField(item, "id", "articleId", "article_id");
    if (!articleId) return null;
    const title = textField(item, "title", "name") || articleId;
    const category = textField(item, "bucket", "bucketName", "articleType", "category");
    const component = textField(item, "component", "system", "componentName");
    const common: SourceReference = { catalog, vehicleId, articleId, kind: "article" };
    const article = {
      opaque_ref: encodeReference(common, key),
      title: title.slice(0, 1000),
      ...(category ? { category: category.slice(0, 256) } : {}),
      ...(component ? { component: component.slice(0, 256) } : {}),
      resource_ref: encodeReference(common, key),
      labor_resource_ref: encodeReference({ ...common, kind: "labor" }, key),
    };
    return article;
  }).filter((item): item is NonNullable<typeof item> => item !== null);
}
export function sourceRevision(value: Buffer): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
export function sha256(value: Buffer): string { return createHash("sha256").update(value).digest("hex"); }
export function reportedArticleCount(envelope: UpstreamEnvelope<unknown>): number | undefined {
  const body = asRecord(envelope.body);
  const all = Array.isArray(body.filterTabs) ? body.filterTabs.find((tab) => textField(tab, "name").toLowerCase() === "all") : undefined;
  for (const candidate of [asRecord(all).articlesCount, body.articlesCount, body.articleCount, body.totalCount]) {
    const value = Number(candidate);
    if (Number.isSafeInteger(value) && value >= 0) return value;
  }
  return undefined;
}
