import { load } from "cheerio";

const PROVIDER_TOKEN = /\bMOTOR\b/gi;
const URL_KEYS = new Set(["url", "href", "src", "srcset", "style"]);

export function maskProviderBranding(value: string): string {
  return value.replace(PROVIDER_TOKEN, "Bankone");
}

export function maskHtmlProviderBranding(html: string): string {
  const $ = load(html, null, false);
  $("*").contents().each((_index, node) => {
    if (node.type === "text") node.data = maskProviderBranding(node.data ?? "");
  });
  $("*").each((_index, element) => {
    for (const name of ["alt", "title"]) {
      const value = $(element).attr(name);
      if (value !== undefined) $(element).attr(name, maskProviderBranding(value));
    }
  });
  return $.root().html() ?? "";
}

export function maskProviderContent<T>(value: T, key?: string): T {
  if (typeof value === "string") {
    if (key === "html") return maskHtmlProviderBranding(value) as T;
    if (key && URL_KEYS.has(key.toLowerCase())) return value;
    return maskProviderBranding(value) as T;
  }
  if (Array.isArray(value)) return value.map((entry) => maskProviderContent(entry)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, maskProviderContent(entryValue, entryKey)])) as T;
  }
  return value;
}
