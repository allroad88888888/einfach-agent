// 通用并发闸门（异步任务上限）—— 与 ./writeQueue、./newId 同类：零依赖的运行时原语，
// 不含任何领域词汇（既不认识委派，也不认识会话）。
//
// 【归位 · 盘点 E8 / 卡 S7b】原先住在 `subagents/concurrency.ts`，于是 `packages/subagents`
//   深导入它时看起来像在引"委派契约"，而 subagents barrel（S2a）已判定它不属委派协议词汇、
//   拒绝收录。既然它是通用原语，就搬到 core 里放通用原语的那一层（runtime/），消费方
//   （core 的 subagents/runtimeState、包侧的 delegationBatch）只是恰好都在委派链路上而已。
//   与 S7a 把 finishReason 判据抽成 `runtime/finishReason` 是同一种处置。
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
