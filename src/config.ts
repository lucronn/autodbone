import { Buffer } from "node:buffer";

export const DEFAULT_UPSTREAM_ENTRY_URL = "https://search.ebscohost.com/login.aspx?authtype=ip,geo,cpid,uid&groupid=main&custid=ns145344&profile=autorepso";
export const DEFAULT_UPSTREAM_PROMPT_VALUE = "20234";

export type Config = {
  host: string;
  port: number;
  apiKeysDatabaseUrl?: string;
  publicBaseUrl?: string;
  upstream: {
    entryUrl: string;
    promptValue: string;
    apiOrigin: string;
    loginOrigin: string;
    allowedContentSources: string[];
  };
  session: {
    filePath: string;
    encryptionKey: Buffer;
    refreshSkewSeconds: number;
    validationPath: string;
  };
  limits: {
    requestTimeoutMs: number;
    maxResponseBytes: number;
    maxAssetBytes: number;
    maxConcurrentUpstream: number;
    maxClientRequestsPerWindow: number;
    clientRateWindowSeconds: number;
    responseCacheMaxEntries: number;
    responseCacheMaxBytes: number;
  };
};

const defaults = {
  host: "127.0.0.1",
  port: 3000,
  entryUrl: DEFAULT_UPSTREAM_ENTRY_URL,
  promptValue: DEFAULT_UPSTREAM_PROMPT_VALUE,
  apiOrigin: "https://sites.motor.com",
  loginOrigin: "https://login.ebsco.com",
  allowedContentSources: ["GeneralMotors", "Motor", "Toyota"],
  filePath: "./data/server-session.enc",
  refreshSkewSeconds: 300,
  validationPath: "/m1/api/years",
  requestTimeoutMs: 15_000,
  maxResponseBytes: 8 * 1024 * 1024,
  maxAssetBytes: 32 * 1024 * 1024,
  maxConcurrentUpstream: 8,
  maxClientRequestsPerWindow: 60,
  clientRateWindowSeconds: 60,
  responseCacheMaxEntries: 512,
  responseCacheMaxBytes: 64 * 1024 * 1024,
} as const;

function required(env: NodeJS.ProcessEnv, key: string, fallback?: string): string {
  const value = env[key]?.trim() || fallback;
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function positiveInteger(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${key} must be a positive integer`);
  return value;
}

function httpsOrigin(value: string, key: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error(`${key} must use HTTPS`);
  return url.origin;
}

function optionalBaseUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const url = new URL(value);
  if (!(["http:", "https:"].includes(url.protocol))) throw new Error("PUBLIC_BASE_URL must use HTTP or HTTPS");
  return url.toString().replace(/\/$/, "");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const entryUrl = required(env, "UPSTREAM_ENTRY_URL", defaults.entryUrl);
  const entry = new URL(entryUrl);
  if (entry.protocol !== "https:") throw new Error("UPSTREAM_ENTRY_URL must use HTTPS");

  const promptValue = required(env, "UPSTREAM_PROMPT_VALUE", defaults.promptValue);
  const keyHex = required(env, "SESSION_ENCRYPTION_KEY");
  if (!/^[a-f0-9]{64}$/i.test(keyHex)) throw new Error("SESSION_ENCRYPTION_KEY must be 32 bytes encoded as 64 hex characters");

  const sources = (env.UPSTREAM_ALLOWED_CONTENT_SOURCES ?? defaults.allowedContentSources.join(","))
    .split(",")
    .map((source) => source.trim())
    .filter(Boolean);
  if (sources.length === 0) throw new Error("UPSTREAM_ALLOWED_CONTENT_SOURCES must contain at least one source");

  return {
    host: env.HOST?.trim() || defaults.host,
    port: positiveInteger(env, "PORT", defaults.port),
    apiKeysDatabaseUrl: env.API_KEYS_DATABASE_URL?.trim() || undefined,
    publicBaseUrl: optionalBaseUrl(env.PUBLIC_BASE_URL),
    upstream: {
      entryUrl,
      promptValue,
      apiOrigin: httpsOrigin(env.UPSTREAM_API_ORIGIN?.trim() || defaults.apiOrigin, "UPSTREAM_API_ORIGIN"),
      loginOrigin: httpsOrigin(env.UPSTREAM_LOGIN_ORIGIN?.trim() || defaults.loginOrigin, "UPSTREAM_LOGIN_ORIGIN"),
      allowedContentSources: sources,
    },
    session: {
      filePath: env.SESSION_FILE_PATH?.trim() || defaults.filePath,
      encryptionKey: Buffer.from(keyHex, "hex"),
      refreshSkewSeconds: positiveInteger(env, "SESSION_REFRESH_SKEW_SECONDS", defaults.refreshSkewSeconds),
      validationPath: env.SESSION_VALIDATION_PATH?.trim() || defaults.validationPath,
    },
    limits: {
      requestTimeoutMs: positiveInteger(env, "REQUEST_TIMEOUT_MS", defaults.requestTimeoutMs),
      maxResponseBytes: positiveInteger(env, "MAX_RESPONSE_BYTES", defaults.maxResponseBytes),
      maxAssetBytes: positiveInteger(env, "MAX_ASSET_BYTES", defaults.maxAssetBytes),
      maxConcurrentUpstream: positiveInteger(env, "MAX_CONCURRENT_UPSTREAM", defaults.maxConcurrentUpstream),
      maxClientRequestsPerWindow: positiveInteger(env, "MAX_CLIENT_REQUESTS_PER_WINDOW", defaults.maxClientRequestsPerWindow),
      clientRateWindowSeconds: positiveInteger(env, "CLIENT_RATE_WINDOW_SECONDS", defaults.clientRateWindowSeconds),
      responseCacheMaxEntries: positiveInteger(env, "RESPONSE_CACHE_MAX_ENTRIES", defaults.responseCacheMaxEntries),
      responseCacheMaxBytes: positiveInteger(env, "RESPONSE_CACHE_MAX_BYTES", defaults.responseCacheMaxBytes),
    },
  };
}
