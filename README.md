# Bankone Source API

This service is a small, direct connector to the same `/m1/api/*` service used by the provider frontend. It does not execute the frontend bundle, render the application, scrape browser content, or expose a general-purpose proxy. It authenticates the upstream service over HTTP, then forwards an explicit allowlist of read-only provider resources.

The connector API itself is unauthenticated by design. Deploy it only behind an authenticated, trusted network boundary such as a private service network, gateway, VPN, or service-to-service policy. Clients of the connector never receive upstream credentials, provider cookies, or the encrypted session key.

## Quick start

Requirements: Node.js 22 or newer.

```bash
npm install
cp .env.example .env
openssl rand -hex 32
npm run build
npm start
```

Supply all upstream authentication values through runtime secrets. The required values are:

- `UPSTREAM_ENTRY_URL`: the authorized entry URL for the institution/profile.
- `UPSTREAM_PROMPT_VALUE`: the authorized prompted-login value.
- `SESSION_ENCRYPTION_KEY`: a 32-byte key encoded as 64 hexadecimal characters.
- `SOURCE_REF_ACTIVE_KEY_ID` and `SOURCE_REF_KEYS_JSON`: a separately managed, versioned 32-byte reference keyring. Keep older keys in the JSON map while stored opaque references still use them; rotate by adding a new key ID and making it active. Session-key rotation does not change source references.

The prompt value is an access credential. The connector does not bypass provider entitlement controls; the operator must supply authorized access.

For development, `npm run dev` starts the TypeScript watcher. The default bind is `127.0.0.1:3000`; change `HOST`, `PORT`, and `PUBLIC_BASE_URL` as needed. `PUBLIC_BASE_URL` is used when normalized HTML is given to a frontend, so it should be the externally reachable connector origin.

### Vercel

The `src/server.ts` Fastify entrypoint also exports the Vercel Node.js handler. Configure `UPSTREAM_ENTRY_URL`, `UPSTREAM_PROMPT_VALUE`, `SESSION_ENCRYPTION_KEY`, `SOURCE_REF_ACTIVE_KEY_ID`, `SOURCE_REF_KEYS_JSON`, `SESSION_FILE_PATH=/tmp/bankone-session.enc`, and `PUBLIC_BASE_URL=https://bankone.cars.tk` in Bankone's own Vercel project. Attach `bankone.cars.tk` directly to that project after the nonproduction contract check. Vercel function filesystems are ephemeral, so durable server-session persistence requires an external encrypted store before relying on reauthentication across cold starts. Apply the service access policy at Bankone's ingress. This repository has no AutoData database or object-store dependency.

## Authentication and persistence

The default request path is:

1. Load the encrypted server session from `SESSION_FILE_PATH`.
2. Validate it after process start when it has no explicit usable expiry.
3. Re-authenticate only when the session is missing, explicitly near expiry, or the upstream returns HTTP 401/403.
4. Retry the idempotent GET once after a refresh.

Concurrent startup validation is single-flight. Upstream requests are bounded by `MAX_CONCURRENT_UPSTREAM`, successful upstream responses retain any renewed session cookies, and a failed refresh briefly enters a shared cooldown so a sustained traversal cannot create an authentication-request stampede.

The session file is AES-256-GCM encrypted, written with restrictive directory/file permissions, and replaced atomically. Session cookies are never written in plaintext. Browser automation is not part of the default runtime because the direct prompted-login HTTP flow is lower latency and has fewer moving parts. A browser fallback is intentionally not enabled by this implementation.

For a trusted caller that already has an authorized upstream session, send the request-scoped header:

```http
X-Upstream-Cookie: SessionIdentifier=...; AuthUserInfo=...
```

That override is used only for the current request, is never persisted, and should be treated as sensitive. The server-side session remains the default when the header is absent. A caller must not send both an override and expect it to update the server session.

Caller requests are admitted through a per-client sliding-window limit before any upstream session or request is used. Excess traffic receives HTTP 429 locally and is not sent upstream. Successful default-session responses use a bounded in-memory cache, and concurrent misses for the same resource are coalesced into one upstream request. Request-scoped cookie overrides bypass the shared cache.

## Public API

The legacy `/v1/api/*` connector routes are `GET`. Upstream response envelopes are retained as `{ header, body }`. Upstream non-2xx responses become a sanitized connector error with a request ID and upstream status; upstream headers, cookies, and bodies are not included in errors.

The provider-neutral source contract lives at `/v1`. Bankone implements `GET /v1/capabilities`, `GET /v1/catalog/{scope}`, `POST /v1/vehicle-resolutions`, `GET /v1/vehicles/{opaqueRef}/articles`, `POST /v1/vehicles/{opaqueRef}/article-search`, and `GET /v1/resources/{opaqueRef}`. `scope` is `years`, `makes`, `models`, or `configurations`. List responses carry `complete` and a bound `next_cursor` when another page exists. Ambiguous vehicle matches remain separate candidates. Vehicle, article, resource, and cursor references are stable authenticated encrypted values; callers cannot choose upstream targets through them. Article and labor responses include SHA-256 over returned content, and binary resources include SHA-256 over decoded bytes. Article resources expose `asset_resource_refs` and content links that resolve through `/v1/resources`. All resource responses emit provenance headers. Catalog cursors bind to the source revision, so callers restart pagination if the upstream list changes. The contract's source envelope carries a request ID, `bankone` provider, source revision, retrieval time, and bank-owned source locator.

Catalog and vehicle routes:

| Connector route | Upstream resource |
| --- | --- |
| `GET /v1/api/years` | `/m1/api/years` |
| `GET /v1/api/year/{year}/makes` | `/m1/api/year/{year}/makes` |
| `GET /v1/api/year/{year}/make/{make}/models` | `/m1/api/year/{year}/make/{make}/models` |
| `GET /v1/api/vin/{vin}/vehicle` | `/m1/api/vin/{vin}/vehicle` |
| `GET /v1/api/catalog/{catalog}/vehicles?vehicleIds=...` | Provider vehicle catalog |
| `GET /v1/api/catalog/{catalog}/{vehicleId}/vehicle-details` | Provider vehicle details |
| `GET /v1/api/catalog/{catalog}/{vehicleId}/name` | Provider vehicle name |

Vehicle content routes:

| Connector route | Allowed query parameters |
| --- | --- |
| `GET /v1/api/catalog/{catalog}/vehicle/{vehicleId}/articles/v2` | `bucketName`, `articleSubtype`, `searchTerm` |
| `GET /v1/api/catalog/{catalog}/vehicle/{vehicleId}/article/{articleId}` | `bucketName`, `articleSubtype`, `searchTerm` |
| `GET /v1/api/catalog/{catalog}/vehicle/{vehicleId}/article/{articleId}/title` | none |
| `GET /v1/api/catalog/{catalog}/vehicle/{vehicleId}/labor/{articleId}` | none |
| `GET /v1/api/catalog/{catalog}/vehicle/{vehicleId}/maintenanceSchedules/frequency` | none |
| `GET /v1/api/catalog/{catalog}/vehicle/{vehicleId}/maintenanceSchedules/intervals` | none |
| `GET /v1/api/catalog/{catalog}/vehicle/{vehicleId}/maintenanceSchedules/indicators` | none |
| `GET /v1/api/catalog/{catalog}/vehicle/{vehicleId}/parts` | none |

Resource routes:

| Connector route | Behavior |
| --- | --- |
| `GET /v1/api/catalog/{catalog}/graphic/{id}` | Read-only graphic bytes, with upstream content type |
| `GET /v1/api/asset/{handleId}` | Read-only asset bytes, with upstream content type |
| `GET /v1/api/catalog/{catalog}/xml/{articleId}` | Read-only XML/text response |
| `GET /v1/api/ui/usersettings` | Read-only user settings envelope |
| `GET /v1/assets/reference/{signedReference}` | Signed, expiring asset proxy used by normalized HTML |

`catalog` is a neutral public alias. The built-in aliases are `gm`, `toyota`, and `catalog`; they map to the configured provider catalogs server-side. Provider catalog names are never required in public route parameters. Path segments are encoded individually, so an article ID such as `4481222:17911387` is sent as one safe segment (`4481222%3A17911387`). Unknown query parameters are rejected rather than forwarded.

## Raw and normalized responses

For JSON routes, the default response preserves upstream metadata and normalizes only an object body that contains an HTML field. Catalog arrays and other JSON bodies are returned unchanged. Add `raw=true` to an HTML-bearing request to get the parsed upstream envelope without normalization:

```text
GET /v1/api/catalog/gm/vehicle/100342221/article/4481222%3A17911387?bucketName=Component%20Location%20Diagrams&articleSubtype=&searchTerm=&raw=true
```

The normalized form keeps the original `header` and document metadata, replaces `body.html`, and adds a `connector` namespace containing `normalized`, `links`, and `resources`. Standalone provider branding in textual fields is replaced with `Bankone`; URLs, asset references, compound catalog names, and opaque identifiers are preserved. Custom provider tags are converted as follows:

- `<mtr-image id="..." ...>` becomes an ordinary `<img>` whose `src` points to a signed connector asset URL.
- `<eplink linkkey="...">` becomes a Bankone catalog article `<a>` link.
- `<emph>` becomes `<em>`.
- Other unknown custom elements become safe `<span>`/`<div>` elements while their unsafe/provider-specific attributes are removed.

The normalizer also handles embedded `src`, `href`, `srcset`, and CSS `url(...)` values. It never fetches resources while normalizing. Only recognized same-origin provider asset paths are converted to signed connector references. Dangerous schemes, malformed URLs, event-handler attributes, scripts, forms, and active embed elements are removed. Signed asset references are opaque HMAC-SHA256 values with a short expiry and are accepted only for allowlisted upstream asset targets.

Example with the supplied article shape:

```json
{
  "header": { "status": "OK", "statusCode": 200 },
  "body": {
    "html": "<h2 class=\"document-header\">Bushing, Bearing, and Washer Locations</h2><img src=\"https://connector.example/v1/assets/reference/...\" alt=\"Bushing, Bearing, and Washer Locations\">",
    "documentId": "4481222",
    "releaseDate": "2016-04-13T13:29:42",
    "publishedDate": "2020-07-01T00:00:00"
  },
  "connector": { "normalized": true, "links": [], "resources": [] }
}
```

## OpenAPI and health

- Swagger UI: [`/docs`](http://127.0.0.1:3000/docs)
- OpenAPI JSON: [`/openapi.json`](http://127.0.0.1:3000/openapi.json)
- Process health: `GET /healthz`
- Readiness shape: `GET /readyz`

The OpenAPI document describes the public legacy and source-contract routes. No connector authentication scheme is advertised because deployment authentication belongs at the trusted-network boundary. Health responses do not reveal upstream cookies or token state.

## Configuration reference

| Variable | Purpose |
| --- | --- |
| `HOST`, `PORT` | Local bind address and port |
| `PUBLIC_BASE_URL` | Base URL embedded in normalized links/assets |
| `UPSTREAM_ENTRY_URL` | Runtime EBSCO entry URL |
| `UPSTREAM_PROMPT_VALUE` | Runtime prompted-login value |
| `UPSTREAM_API_ORIGIN`, `UPSTREAM_LOGIN_ORIGIN` | HTTPS upstream origins |
| `UPSTREAM_ALLOWED_CONTENT_SOURCES` | Comma-separated source allowlist |
| `SESSION_FILE_PATH` | Encrypted server-session location |
| `SESSION_ENCRYPTION_KEY` | 32-byte hex session encryption key |
| `SOURCE_REF_ACTIVE_KEY_ID`, `SOURCE_REF_KEYS_JSON` | Versioned source-reference keyring, managed separately from session encryption |
| `SESSION_REFRESH_SKEW_SECONDS` | Explicit expiry safety window |
| `REQUEST_TIMEOUT_MS` | Per-upstream-request timeout |
| `MAX_RESPONSE_BYTES`, `MAX_ASSET_BYTES` | Bounded upstream response sizes |
| `MAX_CONCURRENT_UPSTREAM` | Maximum concurrent upstream requests; default `8` |
| `MAX_CLIENT_REQUESTS_PER_WINDOW`, `CLIENT_RATE_WINDOW_SECONDS` | Per-caller admission limit; defaults to `60` requests per `60` seconds |
| `RESPONSE_CACHE_MAX_ENTRIES`, `RESPONSE_CACHE_MAX_BYTES` | Bounded in-memory response-cache capacity; defaults to `512` entries and `64 MiB` |

## Verification

```bash
npm test
npm run build
npm run lint
git diff --check
```

The live smoke is intentionally separate and opt-in:

```bash
LIVE_SMOKE=1 npm run live-smoke
```

It uses the configured authorized runtime session, checks years, 2024 makes, and the configured/example article target, and prints only sanitized route/status/timing/shape evidence. It does not create a session file in the repository. If runtime configuration is not present or the upstream rejects access, it exits nonzero with a sanitized error code.
