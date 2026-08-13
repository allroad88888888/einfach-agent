export interface AbortRegistryLike {
  beginRun(id: string): AbortSignal
  abortRun(id: string): void
  endRun(id: string, signal: AbortSignal): void
  isRunning(id: string): boolean
  reset(): void
}

/** Creates the abort-controller registry owned by exactly one CoreInstance. */
export function createAbortRegistry(): AbortRegistryLike {
  const controllers = new Map<string, AbortController>()
  return {
    beginRun(id) {
      controllers.get(id)?.abort()
      const controller = new AbortController()
      controllers.set(id, controller)
      return controller.signal
    },
    abortRun(id) {
      const controller = controllers.get(id)
      if (!controller) return
      controller.abort()
      controllers.delete(id)
    },
    endRun(id, signal) {
      if (controllers.get(id)?.signal === signal) controllers.delete(id)
    },
    isRunning(id) {
      return controllers.has(id)
    },
    reset() {
      controllers.clear()
    },
  }
}
