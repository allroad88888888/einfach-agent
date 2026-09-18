export class ApiToolsError extends Error {
  constructor(
    readonly code: ApiToolsErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message)
    this.name = 'ApiToolsError'
  }
}

export type ApiToolsErrorCode =
  | 'API_OPTIONS_INVALID_INPUT'
  | 'API_OPTIONS_UNKNOWN_SOURCE'
  | 'API_OPTIONS_FORBIDDEN'
  | 'API_OPTIONS_INVALID_RESPONSE'
  | 'API_OPTIONS_CANCELLED'
  | 'API_OPTIONS_TIMEOUT'
  | 'API_OPTIONS_UNAUTHORIZED'
  | 'API_OPTIONS_RATE_LIMITED'
  | 'API_OPTIONS_SERVICE_ERROR'
  | 'API_OPTIONS_NETWORK_ERROR'
