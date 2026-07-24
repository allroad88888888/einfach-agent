export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

export function errorMessage(value: unknown): string {
  return toError(value).message
}

export function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason
  const error = reason instanceof Error ? reason : new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortError(signal)
  }
}

export function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  throwIfAborted(signal)

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup()
      reject(abortError(signal))
    }
    const cleanup = () => signal.removeEventListener('abort', onAbort)

    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error) => {
        cleanup()
        reject(error)
      },
    )
  })
}

export function combineAbortSignals(
  ...signals: Array<AbortSignal | undefined>
): { signal?: AbortSignal; dispose(): void } {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined)
  if (present.length === 0) return { signal: undefined, dispose() {} }
  if (present.length === 1) return { signal: present[0], dispose() {} }

  const controller = new AbortController()
  const subscriptions = new Map<AbortSignal, () => void>()
  const dispose = () => {
    for (const [signal, listener] of subscriptions) {
      signal.removeEventListener('abort', listener)
    }
    subscriptions.clear()
  }

  for (const signal of present) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      break
    }
    const listener = () => {
      controller.abort(signal.reason)
      dispose()
    }
    subscriptions.set(signal, listener)
    signal.addEventListener('abort', listener, { once: true })
  }

  return { signal: controller.signal, dispose }
}

export function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Hard protocol-boundary limits for untrusted tools/list responses. */
export const MCP_TOOLS_LIST_MAX_PAGES = 100
export const MCP_SERVER_MAX_TOOLS = 1_000
