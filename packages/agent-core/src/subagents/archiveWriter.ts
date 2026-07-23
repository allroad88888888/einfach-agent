import type { SubagentArchiveWriteMode } from './types'

export interface SubagentArchiveWriteInput {
  path: string
  content: string
  mode: SubagentArchiveWriteMode
}

type ArchiveWriteExecutor = (input: SubagentArchiveWriteInput) => Promise<void>

interface PendingAppend {
  content: string[]
  executor: ArchiveWriteExecutor
  waiters: Array<{ resolve(): void; reject(error: unknown): void }>
}

// Archive indexes are shared by every root run. Keep the path lock process-wide,
// while batching/lifecycle remain scoped to an individual runtime writer.
const sharedPathTails = new Map<string, Promise<void>>()

/**
 * Serializes writes to the same archive path. Selected JSONL indexes may opt into
 * microtask batching; the event log deliberately does not, preserving one
 * append-only write per audit event.
 */
export class SubagentArchiveWriter {
  private readonly operations = new Set<Promise<void>>()
  private readonly pendingAppends = new Map<string, PendingAppend>()
  private batchScheduled = false
  private closed = false

  write(
    input: SubagentArchiveWriteInput,
    executor: ArchiveWriteExecutor,
    options: { batchAppend?: boolean } = {},
  ): Promise<void> {
    if (this.closed) return Promise.reject(new Error('subagent archive writer is closed'))
    if (input.mode === 'append' && options.batchAppend) {
      return this.queueBatchedAppend(input, executor)
    }
    this.drainPendingPath(input.path)
    return this.enqueue(input.path, () => executor(input))
  }

  async flush(): Promise<void> {
    this.drainAllPending()
    let firstError: unknown
    while (this.operations.size > 0) {
      const settled = await Promise.allSettled([...this.operations])
      firstError ??= settled.find((result) => result.status === 'rejected')?.reason
      // Writes may enqueue more same-runtime work while this batch is settling.
      // Keep draining until the writer is genuinely idle before surfacing failure.
      this.drainAllPending()
    }
    if (firstError !== undefined) throw firstError
  }

  async close(): Promise<void> {
    if (this.closed) return this.flush()
    this.closed = true
    await this.flush()
  }

  private queueBatchedAppend(
    input: SubagentArchiveWriteInput,
    executor: ArchiveWriteExecutor,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const pending = this.pendingAppends.get(input.path)
      if (pending) {
        pending.content.push(input.content)
        pending.waiters.push({ resolve, reject })
      } else {
        this.pendingAppends.set(input.path, {
          content: [input.content],
          executor,
          waiters: [{ resolve, reject }],
        })
      }
      if (!this.batchScheduled) {
        this.batchScheduled = true
        queueMicrotask(() => {
          this.batchScheduled = false
          this.drainAllPending()
        })
      }
    })
  }

  private drainAllPending(): void {
    for (const path of [...this.pendingAppends.keys()]) this.drainPendingPath(path)
  }

  private drainPendingPath(path: string): void {
    const pending = this.pendingAppends.get(path)
    if (!pending) return
    this.pendingAppends.delete(path)
    const operation = this.enqueue(path, () =>
      pending.executor({ path, content: pending.content.join(''), mode: 'append' }),
    )
    void operation.then(
      () => pending.waiters.forEach((waiter) => waiter.resolve()),
      (error) => pending.waiters.forEach((waiter) => waiter.reject(error)),
    )
  }

  private enqueue(path: string, task: () => Promise<void>): Promise<void> {
    const previous = sharedPathTails.get(path) ?? Promise.resolve()
    const operation = previous.catch(() => undefined).then(task)
    sharedPathTails.set(path, operation)
    this.operations.add(operation)
    const cleanup = () => {
      this.operations.delete(operation)
      if (sharedPathTails.get(path) === operation) sharedPathTails.delete(path)
    }
    void operation.then(cleanup, cleanup)
    return operation
  }
}
