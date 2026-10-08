import { load, type CheerioAPI } from "cheerio";
import type { Element } from "domhandler";
import { rewriteResources, type AssetTarget, type RewrittenResource } from "./url-rewriter.js";

export type HtmlNormalizationContext = {
  publicBaseUrl: string;
  contentSource: string;
  publicCatalog: string;
  vehicleId: string;
  connectorAssetUrl: (target: AssetTarget) => string;
  connectorArticleUrl?: (articleId: string) => string;
  upstreamOrigin?: string;
  allowedExternalOrigins?: readonly string[];
};

export type NormalizedHtml = {
  html: string;
  links: string[];
  resources: RewrittenResource[];
};

const HTML_TAGS = new Set([
  "a", "abbr", "article", "aside", "b", "blockquote", "br", "button", "caption", "code", "col", "colgroup",
  "dd", "del", "details", "div", "dl", "dt", "em", "figcaption", "figure", "footer", "h1", "h2", "h3", "h4",
  "h5", "h6", "head", "header", "hr", "i", "img", "li", "main", "mark", "nav", "ol", "p", "pre", "q", "s",
  "section", "small", "span", "strong", "sub", "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead",
  "tr", "u", "ul",
]);
const BLOCK_TAGS = new Set(["article", "aside", "blockquote", "div", "dl", "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "main", "nav", "ol", "p", "pre", "section", "table", "ul"]);
const SAFE_ATTRIBUTES = new Set(["id", "class", "title", "alt", "width", "height", "role", "colspan", "rowspan", "scope"]);
const URL_ATTRIBUTES = new Set(["href", "src", "srcset", "style"]);

function articleUrl(context: HtmlNormalizationContext, articleId: string): string {
  if (context.connectorArticleUrl) return context.connectorArticleUrl(articleId);
  return `${context.publicBaseUrl}/v1/api/catalog/${encodeURIComponent(context.publicCatalog)}/vehicle/${encodeURIComponent(context.vehicleId)}/article/${encodeURIComponent(articleId)}`;
}

function copySafeAttributes($: CheerioAPI, from: any, to: any, includeData = true): void {
  for (const [name, value] of Object.entries(from.attribs ?? {})) {
    const lower = name.toLowerCase();
    if (lower.startsWith("on") || URL_ATTRIBUTES.has(lower)) continue;
    if (SAFE_ATTRIBUTES.has(lower) || (includeData && lower.startsWith("data-safe-")) || lower.startsWith("aria-")) {
      $(to).attr(lower, String(value));
    }
  }
}

function normalizeCustomTags($: CheerioAPI, context: HtmlNormalizationContext): void {
  $("script, iframe, object, embed, style, form, input, textarea, select, option, button").remove();

  $("*").each((_index, element) => {
    const node = element as Element;
    const name = node.name.toLowerCase();
    if (name === "mtr-image") {
      const id = node.attribs?.id;
      if (!id) {
        $(node).remove();
        return;
      }
      const image = $("<img>");
      image.attr("src", context.connectorAssetUrl({ kind: "source", source: context.contentSource, id }));
      copySafeAttributes($, node, image[0], false);
      $(node).replaceWith(image);
      return;
    }
    if (name === "emph") {
      const replacement = $("<em>");
      copySafeAttributes($, node, replacement[0], false);
      replacement.append($(node).contents());
      $(node).replaceWith(replacement);
      return;
    }
    if (name === "eplink") {
      const articleId = node.attribs?.linkkey;
      const replacement = $("<a>");
      if (articleId) replacement.attr("href", articleUrl(context, articleId));
      copySafeAttributes($, node, replacement[0], false);
      replacement.append($(node).contents());
      $(node).replaceWith(replacement);
      return;
    }
    if (!HTML_TAGS.has(name)) {
      const replacement = $(`<${BLOCK_TAGS.has(name) ? "div" : "span"}>`);
      replacement.append($(node).contents());
      $(node).replaceWith(replacement);
    }
  });
}

export function normalizeHtml(html: string, context: HtmlNormalizationContext): NormalizedHtml {
  const $ = load(html, null, false);
  normalizeCustomTags($, context);
  for (const element of $("*").toArray()) {
    const node = element as Element;
    for (const [name] of Object.entries(node.attribs ?? {})) {
      const lower = name.toLowerCase();
      const allowed = SAFE_ATTRIBUTES.has(lower)
        || URL_ATTRIBUTES.has(lower)
        || lower.startsWith("aria-")
        || lower.startsWith("data-safe-");
      if (!allowed) $(node).removeAttr(name);
    }
  }
  const rewritten = rewriteResources($.root().html() ?? "", {
    upstreamOrigin: context.upstreamOrigin ?? "https://sites.motor.com",
    connectorAssetUrl: context.connectorAssetUrl,
    allowedExternalOrigins: [
      new URL(context.publicBaseUrl).origin,
      ...(context.allowedExternalOrigins ?? []),
    ],
  });
  return rewritten;
}
