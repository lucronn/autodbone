export type ConnectorErrorCode =
  | "configuration_error"
  | "invalid_request"
  | "parts_unavailable"
  | "labor_unavailable"
  | "maintenance_schedule_unavailable"
  | "asset_unavailable"
  | "client_rate_limited"
  | "upstream_auth_failed"
  | "upstream_error"
  | "upstream_timeout"
  | "upstream_response_too_large"
  | "blocked_upstream_target"
  | "invalid_asset_reference"
  | "expired_asset_reference"
  | "browser_fallback_unconfigured"
  | "unauthenticated"
  | "key_store_unavailable"
  | "internal_error";

export class ConnectorError extends Error {
  readonly name = "ConnectorError";

  constructor(
    readonly code: ConnectorErrorCode,
    message: string,
    readonly status = 500,
    readonly upstreamStatus?: number,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export function serializeError(error: unknown, requestId: string): { error: Record<string, string | number> } {
  if (error instanceof ConnectorError) {
    const result: Record<string, string | number> = {
      code: error.code,
      message: error.message,
      requestId,
    };
    if (error.upstreamStatus !== undefined) result.upstreamStatus = error.upstreamStatus;
    return { error: result };
  }

  return {
    error: {
      code: "internal_error",
      message: "Internal connector error",
      requestId,
    },
  };
}
