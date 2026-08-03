export interface ConcurrencyLimiter {
  run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T>
  runAll<T>(tasks: readonly (() => Promise<T>)[]): Promise<T[]>
}

function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError')
}

/** Enforces a ceiling for asynchronous work. */
export function createConcurrencyLimiter(maxConcurrent: number): ConcurrencyLimiter {
  let active = 0
  const waiters: Array<() => void> = []

  function acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError())
    if (active < maxConcurrent) {
      active += 1
      return Promise.resolve()
    }

    return new Promise<void>((resolve, reject) => {
      const wake = () => {
        signal?.removeEventListener('abort', onAbort)
        active += 1
        resolve()
      }
      const onAbort = () => {
        const index = waiters.indexOf(wake)
        if (index >= 0) waiters.splice(index, 1)
        reject(abortError())
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      waiters.push(wake)
    })
  }

  function release(): void {
    active -= 1
    waiters.shift()?.()
  }

  async function run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await acquire(signal)
    try {
      return await task()
    } finally {
      release()
    }
  }

  async function runAll<T>(tasks: readonly (() => Promise<T>)[]): Promise<T[]> {
    const results: T[] = []
    let nextIndex = 0

    async function worker(): Promise<void> {
      for (;;) {
        const index = nextIndex
        nextIndex += 1
        if (index >= tasks.length) return
        results[index] = await run(tasks[index])
      }
    }

    const workers = Array.from(
      { length: Math.max(1, Math.min(maxConcurrent, tasks.length)) },
      () => worker(),
    )
    await Promise.all(workers)
    return results
  }

  return { run, runAll }
}
