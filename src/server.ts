import type { IncomingMessage, ServerResponse } from "node:http";
import Fastify, { type FastifyInstance } from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { loadConfig, type Config } from "./config.js";
import { EbscoHttpAuthAdapter } from "./auth/ebsco-http-auth-adapter.js";
import { EncryptedSessionStore } from "./auth/session-store.js";
import { SessionManager } from "./auth/session-manager.js";
import { UpstreamApiClient } from "./upstream/upstream-client.js";
import { AssetProxy } from "./assets/asset-proxy.js";
import { ConnectorError, serializeError } from "./errors.js";
import { registerApiRoutes } from "./routes/api-routes.js";
import { registerAssetRoutes } from "./routes/asset-routes.js";
import { registerHealthRoutes } from "./routes/health-routes.js";
import { registerOpenApi } from "./openapi.js";
import { ClientRateLimiter } from "./http/client-rate-limiter.js";
import { ResponseCache } from "./http/response-cache.js";
import { bearerToken, createApiKeyVerifier, type ApiKeyVerifier } from "./api-keys.js";

export type ConnectorDependencies = {
  config: Config;
  upstreamClient?: UpstreamApiClient;
  sessionManager?: SessionManager;
  assetProxy?: AssetProxy;
  apiKeyVerifier?: ApiKeyVerifier;
};

export async function createApp(deps: ConnectorDependencies): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, requestIdHeader: "x-request-id", routerOptions: { maxParamLength: 1024 } });
  const upstreamClient = deps.upstreamClient ?? new UpstreamApiClient(deps.config);
  const sessionManager = deps.sessionManager ?? new SessionManager(
    new EbscoHttpAuthAdapter(deps.config),
    new EncryptedSessionStore(deps.config.session.filePath, deps.config.session.encryptionKey),
    { refreshSkewSeconds: deps.config.session.refreshSkewSeconds },
  );
  const assetProxy = deps.assetProxy ?? new AssetProxy(upstreamClient, deps.config);
  const clientRateLimiter = new ClientRateLimiter({
    maxRequests: deps.config.limits.maxClientRequestsPerWindow,
    windowSeconds: deps.config.limits.clientRateWindowSeconds,
  });
  const responseCache = new ResponseCache({
    maxEntries: deps.config.limits.responseCacheMaxEntries,
    maxBytes: deps.config.limits.responseCacheMaxBytes,
  });
  const testBypass = process.env.NODE_ENV === "test" && !deps.apiKeyVerifier && !deps.config.apiKeysDatabaseUrl;
  const verifyApiKey = deps.apiKeyVerifier ?? createApiKeyVerifier(deps.config.apiKeysDatabaseUrl, testBypass);

  app.setErrorHandler((error, request, reply) => {
    const serialized = serializeError(error, request.id);
    reply.code((error as { statusCode?: number }).statusCode ?? (error as { status?: number }).status ?? 500).send(serialized);
  });
  await app.register(swagger, {
      openapi: {
      openapi: "3.0.3",
      info: { title: "Bankone Read-only API", version: "0.1.0" },
    },
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });
  app.get("/openapi.json", async () => app.swagger());
  app.addHook("preHandler", async (request) => {
    if (!request.url.split("?", 1)[0].startsWith("/v1/")) return;
    const token = bearerToken(request.headers.authorization);
    if ((!token && !testBypass) || (token && !(await verifyApiKey(token, "bankone")))) {
      throw new ConnectorError("unauthenticated", "A valid Bankone API key is required", 401);
    }
  });
  registerApiRoutes(app, { config: deps.config, upstreamClient, sessionManager, clientRateLimiter, responseCache });
  registerAssetRoutes(app, { config: deps.config, assetProxy, sessionManager });
  registerHealthRoutes(app);
  await app.ready();
  await registerOpenApi(app);
  return app;
}

let serverlessAppPromise: Promise<FastifyInstance> | undefined;

function getServerlessApp(): Promise<FastifyInstance> {
  if (!serverlessAppPromise) serverlessAppPromise = createApp({ config: loadConfig() });
  return serverlessAppPromise;
}

export default async function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const app = await getServerlessApp();
  app.server.emit("request", request, response);
}
