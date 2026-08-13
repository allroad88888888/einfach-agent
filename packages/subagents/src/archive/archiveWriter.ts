import type { SubagentArchiveWriteMode } from '@web-agent/core/subagents'

export interface SubagentArchiveWriteInput {
  path: string
  content: string
  mode: SubagentArchiveWriteMode
}

export interface SubagentArchiveWriteTelemetryContext {
  sessionId?: string
  runId?: string
  vendor?: string
  model?: string
}

export interface SubagentArchiveTraceRecorder {
  recordCompletedSpan(name: string, input: {
    kind: 'internal'
    startedAt: number
    endedAt: number
    status: 'ok' | 'error'
    attrs: Record<string, string | number | undefined>
  }): void
}

/** Explicit host-owned context; archive code never reaches for a process default core. */
export interface SubagentArchiveWriterContext {
  readonly queueKey: object
  readonly traceRecorder?: SubagentArchiveTraceRecorder
}

type ArchiveWriteExecutor = (input: SubagentArchiveWriteInput) => Promise<void>

interface PendingAppend {
  content: string[]
  executor: ArchiveWriteExecutor
  waiters: Array<{ resolve(): void; reject(error: unknown): void }>
}

// A core can have multiple runtime writers, but no write queue may leak to another core.
const pathTailsByCore = new WeakMap<object, Map<string, Promise<void>>>()

function pathTailsFor(core: object): Map<string, Promise<void>> {
  let pathTails = pathTailsByCore.get(core)
  if (!pathTails) {
    pathTails = new Map<string, Promise<void>>()
    pathTailsByCore.set(core, pathTails)
  }
  return pathTails
}

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
  private writeAttempts = 0
  private writeFailures = 0
  private writeMetricRecorded = false

  constructor(
    private readonly context: SubagentArchiveWriterContext,
    private readonly telemetry: SubagentArchiveWriteTelemetryContext = {},
  ) {}

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
    try {
      await this.flush()
    } finally {
      this.recordWriteSummary()
    }
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
    const pathTails = pathTailsFor(this.context.queueKey)
    const previous = pathTails.get(path) ?? Promise.resolve()
    const operation = previous.catch(() => undefined).then(task)
    this.writeAttempts += 1
    pathTails.set(path, operation)
    this.operations.add(operation)
    const cleanup = () => {
      this.operations.delete(operation)
      if (pathTails.get(path) === operation) pathTails.delete(path)
    }
    void operation.then(cleanup, () => {
      this.writeFailures += 1
      cleanup()
    })
    return operation
  }

  private recordWriteSummary(): void {
    if (this.writeMetricRecorded) return
    this.writeMetricRecorded = true
    const endedAt = Date.now()
    this.context.traceRecorder?.recordCompletedSpan('subagent.archive_write_summary', {
      kind: 'internal',
      startedAt: endedAt,
      endedAt,
      status: this.writeFailures > 0 ? 'error' : 'ok',
      attrs: {
        ...this.telemetry,
        archive_write_attempts: this.writeAttempts,
        archive_write_failures: this.writeFailures,
        archive_write_failure_rate: this.writeAttempts === 0 ? 0 : this.writeFailures / this.writeAttempts,
      },
    })
  }
}
