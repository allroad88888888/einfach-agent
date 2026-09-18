import { ApiToolsError } from './api-error'
import type { ApiCallContext } from './options-host'

export function runQueryWithDeadline<T>(
  query: (ctx: ApiCallContext) => Promise<T>,
  ctx: ApiCallContext,
  timeoutMs: number,
): Promise<T> {
  if (ctx.signal.aborted) {
    return Promise.reject(new ApiToolsError('API_OPTIONS_CANCELLED', 'options query was cancelled'))
  }

  const controller = new AbortController()
  return new Promise<T>((resolve, reject) => {
    let finished = false
    const finish = (complete: () => void) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      ctx.signal.removeEventListener('abort', cancel)
      complete()
    }
    const cancel = () => {
      controller.abort()
      finish(() => reject(new ApiToolsError('API_OPTIONS_CANCELLED', 'options query was cancelled')))
    }
    const timeout = () => {
      controller.abort()
      finish(() => reject(new ApiToolsError('API_OPTIONS_TIMEOUT', 'options query timed out', true)))
    }
    const timer = setTimeout(timeout, timeoutMs)

    ctx.signal.addEventListener('abort', cancel, { once: true })
    void Promise.resolve().then(() => query({ sessionId: ctx.sessionId, signal: controller.signal })).then(
      (result) => finish(() => resolve(result)),
      (error) => finish(() => reject(error)),
    )
  })
}
