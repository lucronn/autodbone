import { load } from "cheerio";
import type { Element } from "domhandler";

export type AssetTarget = {
  kind: "source" | "graphic" | "asset";
  id: string;
  source?: string;
};

export type ResourceRewriteContext = {
  upstreamOrigin: string;
  connectorAssetUrl: (target: AssetTarget) => string;
  allowedExternalOrigins?: readonly string[];
};

export type RewrittenResource = {
  url: string;
  kind: "asset" | "external";
  attribute: "src" | "href" | "srcset" | "style";
};

export type RewrittenResources = {
  html: string;
  links: string[];
  resources: RewrittenResource[];
};

const CANONICAL_CONTENT_SOURCES: Record<string, string> = {
  generalmotors: "GeneralMotors",
  motor: "Motor",
  toyota: "Toyota",
};

function canonicalContentSource(value: string): string | undefined {
  return CANONICAL_CONTENT_SOURCES[value.toLowerCase()];
}

function targetForUrl(value: string, context: ResourceRewriteContext): AssetTarget | undefined {
  let url: URL;
  try {
    url = new URL(value, context.upstreamOrigin);
  } catch {
    return undefined;
  }
  if (url.origin !== new URL(context.upstreamOrigin).origin) return undefined;
  const parts = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  const apiIndex = parts[0] === "m1" && parts[1] === "api"
    ? 2
    : parts[0] === "api"
      ? 1
      : -1;
  if (apiIndex < 0) return undefined;
  if (parts[apiIndex] === "asset" && parts[apiIndex + 1]) {
    return { kind: "asset", id: parts[apiIndex + 1] };
  }
  if (parts[apiIndex] === "source" && parts[apiIndex + 2] === "graphic" && parts[apiIndex + 3]) {
    const source = canonicalContentSource(parts[apiIndex + 1] ?? "");
    if (!source) return undefined;
    return { kind: "graphic", source, id: parts[apiIndex + 3] };
  }
  return undefined;
}

function rewriteUrl(value: string, attribute: RewrittenResource["attribute"], context: ResourceRewriteContext, resources: RewrittenResource[], links: Set<string>): string {
  const target = targetForUrl(value, context);
  if (target) {
    const rewritten = context.connectorAssetUrl(target);
    resources.push({ url: rewritten, kind: "asset", attribute });
    return rewritten;
  }

  try {
    const url = new URL(value, context.upstreamOrigin);
    const allowedExternal = url.protocol === "https:" && (context.allowedExternalOrigins ?? []).includes(url.origin);
    if (allowedExternal) {
      links.add(url.toString());
      resources.push({ url: url.toString(), kind: "external", attribute });
      return url.toString();
    }
  } catch {
    // The caller removes malformed values from the rendered markup.
  }
  return "";
}

function rewriteSrcset(value: string, context: ResourceRewriteContext, resources: RewrittenResource[], links: Set<string>): string {
  return value.split(",").map((candidate) => {
    const match = candidate.trim().match(/^(\S+)(.*)$/);
    if (!match) return "";
    const rewritten = rewriteUrl(match[1], "srcset", context, resources, links);
    return rewritten ? `${rewritten}${match[2]}` : "";
  }).filter(Boolean).join(", ");
}

function rewriteStyle(value: string, context: ResourceRewriteContext, resources: RewrittenResource[], links: Set<string>): string {
  return value.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (_match, quote: string, rawUrl: string) => {
    const rewritten = rewriteUrl(rawUrl, "style", context, resources, links);
    return rewritten ? `url(${quote}${rewritten}${quote})` : "";
  });
}

export function rewriteResources(html: string, context: ResourceRewriteContext): RewrittenResources {
  const $ = load(html, null, false);
  const resources: RewrittenResource[] = [];
  const links = new Set<string>();

  $("*").each((_index, element) => {
    const node = element as Element;
    for (const [name, rawValue] of Object.entries(node.attribs ?? {})) {
      const value = String(rawValue);
      if (name === "src" || name === "href") {
        const rewritten = rewriteUrl(value, name, context, resources, links);
        if (rewritten) $(element).attr(name, rewritten);
        else $(element).removeAttr(name);
      } else if (name === "srcset") {
        const rewritten = rewriteSrcset(value, context, resources, links);
        if (rewritten) $(element).attr(name, rewritten);
        else $(element).removeAttr(name);
      } else if (name === "style") {
        const rewritten = rewriteStyle(value, context, resources, links);
        if (rewritten) $(element).attr(name, rewritten);
        else $(element).removeAttr(name);
      }
    }
  });

  return { html: $.root().html() ?? "", links: [...links], resources };
}
