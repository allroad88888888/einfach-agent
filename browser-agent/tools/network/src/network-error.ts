export type NetworkErrorCode = 'INVALID_INPUT' | 'RECORDER_UNAVAILABLE' | 'CAPTURE_NOT_FOUND' | 'REQUEST_NOT_FOUND' | 'CAPTURE_STOPPED' | 'DOCUMENT_CHANGED' | 'TIMEOUT' | 'CANCELLED'

export class NetworkToolsError extends Error {
  constructor(readonly code: NetworkErrorCode) { super(code); this.name = 'NetworkToolsError' }
}

export function fail(code: NetworkErrorCode): never { throw new NetworkToolsError(code) }
