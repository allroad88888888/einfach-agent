import type { WindowNetworkRecorderOptions } from './types'
import { releaseObserver, retainObserver } from './window-observer'

export function installWindowNetworkRecorder(options: WindowNetworkRecorderOptions): { dispose(): void } {
  const maxRequests = integer(options.maxRequests, 100, 1, 500)
  const maxBodyChars = integer(options.maxBodyChars, 32768, 1, 65536)
  const maxAgeMs = options.retainForDocument ? undefined : integer(options.maxAgeMs, 300000, 1, 600000)
  const limits = { maxRequests, maxBodyChars, maxAgeMs }
  let observer = retainObserver(options.window, limits, true)
  let disposed = false
  const pageshow = (event: PageTransitionEvent) => {
    if (!disposed && event.persisted) observer = retainObserver(options.window, limits, true)
  }
  options.window.addEventListener('pageshow', pageshow)
  return {
    dispose() {
      if (disposed) return
      disposed = true
      options.window.removeEventListener('pageshow', pageshow)
      releaseObserver(options.window, observer, true)
    },
  }
}

function integer(value: number | undefined, fallback: number, min: number, max: number): number {
  const result = value ?? fallback
  if (!Number.isInteger(result) || result < min || result > max) throw new TypeError('invalid network recorder option')
  return result
}
