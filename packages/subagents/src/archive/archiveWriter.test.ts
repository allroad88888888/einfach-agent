import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  configureObservability,
  flushObservability,
  recordCompletedSpan,
  resetObservability,
} from '@web-agent/core/observability/trace'
import type { TraceDriver, TraceEvent, TraceSpan } from '@web-agent/core/observability/types'
import { createCoreInstance } from '@web-agent/core/runtime/core/coreInstance'
import { SubagentArchiveWriter, type SubagentArchiveWriteInput } from './archiveWriter'

function writerContext(queueKey: object = {}): { queueKey: object } {
  return { queueKey }
}

function mockDriver(): TraceDriver & { spans: TraceSpan[]; events: TraceEvent[] } {
  const spans: TraceSpan[] = []
  const events: TraceEvent[] = []
  return {
    spans,
    events,
    async writeSpan(span) {
      spans.push(span)
    },
    async writeEvent(event) {
      events.push(event)
    },
  }
}

afterEach(() => {
  resetObservability()
})

describe('SubagentArchiveWriter', () => {
  it('batches concurrent index appends into one write', async () => {
    const writes: SubagentArchiveWriteInput[] = []
    const execute = vi.fn(async (input: SubagentArchiveWriteInput) => { writes.push(input) })
    const writer = new SubagentArchiveWriter(writerContext())

    const first = writer.write(
      { path: '.webAgent-archive/index/skills.jsonl', content: 'one\n', mode: 'append' },
      execute,
      { batchAppend: true },
    )
    const second = writer.write(
      { path: '.webAgent-archive/index/skills.jsonl', content: 'two\n', mode: 'append' },
      execute,
      { batchAppend: true },
    )
    await Promise.all([first, second, writer.flush()])

    expect(writes).toEqual([
      { path: '.webAgent-archive/index/skills.jsonl', content: 'one\ntwo\n', mode: 'append' },
    ])
  })

  it('serializes concurrent writes to one path without blocking another path', async () => {
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const order: string[] = []
    const writer = new SubagentArchiveWriter(writerContext())
    const execute = async (input: SubagentArchiveWriteInput) => {
      order.push(`start:${input.content}`)
      if (input.content === 'first') await firstGate
      order.push(`end:${input.content}`)
    }

    const first = writer.write({ path: 'same', content: 'first', mode: 'overwrite' }, execute)
    const second = writer.write({ path: 'same', content: 'second', mode: 'overwrite' }, execute)
    const other = writer.write({ path: 'other', content: 'other', mode: 'overwrite' }, execute)
    await other
    expect(order).toEqual(['start:first', 'start:other', 'end:other'])
    releaseFirst()
    await Promise.all([first, second])
    expect(order).toEqual([
      'start:first', 'start:other', 'end:other', 'end:first', 'start:second', 'end:second',
    ])
  })

  it('serializes the same path across writers owned by one core', async () => {
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const order: string[] = []
    const core = createCoreInstance()
    const firstWriter = new SubagentArchiveWriter(writerContext(core))
    const secondWriter = new SubagentArchiveWriter(writerContext(core))
    const execute = async (input: SubagentArchiveWriteInput) => {
      order.push(`start:${input.content}`)
      if (input.content === 'run-one') await firstGate
      order.push(`end:${input.content}`)
    }

    const first = firstWriter.write({ path: 'shared-index', content: 'run-one', mode: 'append' }, execute)
    const second = secondWriter.write({ path: 'shared-index', content: 'run-two', mode: 'append' }, execute)
    await vi.waitFor(() => expect(order).toEqual(['start:run-one']))
    releaseFirst()
    await Promise.all([first, second])
    expect(order).toEqual(['start:run-one', 'end:run-one', 'start:run-two', 'end:run-two'])
  })

  it('does not block the same path between different cores', async () => {
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const order: string[] = []
    const firstWriter = new SubagentArchiveWriter(writerContext(createCoreInstance()))
    const secondWriter = new SubagentArchiveWriter(writerContext(createCoreInstance()))
    const execute = async (input: SubagentArchiveWriteInput) => {
      order.push(`start:${input.content}`)
      if (input.content === 'run-one') await firstGate
      order.push(`end:${input.content}`)
    }

    const first = firstWriter.write({ path: 'shared-index', content: 'run-one', mode: 'append' }, execute)
    await vi.waitFor(() => expect(order).toEqual(['start:run-one']))
    const second = secondWriter.write({ path: 'shared-index', content: 'run-two', mode: 'append' }, execute)
    await second
    expect(order).toEqual(['start:run-one', 'start:run-two', 'end:run-two'])
    releaseFirst()
    await first
  })

  it('propagates a batched flush failure to every caller and flush', async () => {
    const failure = new Error('disk full')
    const writer = new SubagentArchiveWriter(writerContext())
    const execute = vi.fn(async () => { throw failure })
    const first = writer.write({ path: 'index', content: 'one\n', mode: 'append' }, execute, { batchAppend: true })
    const second = writer.write({ path: 'index', content: 'two\n', mode: 'append' }, execute, { batchAppend: true })

    const results = await Promise.allSettled([first, second, writer.flush()])
    expect(results).toEqual([
      expect.objectContaining({ status: 'rejected', reason: failure }),
      expect.objectContaining({ status: 'rejected', reason: failure }),
      expect.objectContaining({ status: 'rejected', reason: failure }),
    ])
  })

  it('waits for every in-flight path before flush reports the first failure', async () => {
    let releaseSlow!: () => void
    const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve })
    const completed: string[] = []
    const failure = new Error('index unavailable')
    const writer = new SubagentArchiveWriter(writerContext())

    const failed = writer.write(
      { path: 'failed-index', content: 'bad', mode: 'append' },
      async () => { throw failure },
    )
    const slow = writer.write(
      { path: 'slow-snapshot', content: 'tree', mode: 'overwrite' },
      async () => {
        await slowGate
        completed.push('slow')
      },
    )
    let flushSettled = false
    const flush = writer.flush().finally(() => { flushSettled = true })

    await expect(failed).rejects.toBe(failure)
    await Promise.resolve()
    expect(flushSettled).toBe(false)
    releaseSlow()
    await slow
    await expect(flush).rejects.toBe(failure)
    expect(completed).toEqual(['slow'])
  })

  it('close performs a final flush and rejects later writes', async () => {
    const execute = vi.fn(async () => undefined)
    const writer = new SubagentArchiveWriter(writerContext())
    const pending = writer.write({ path: 'index', content: 'line\n', mode: 'append' }, execute, { batchAppend: true })

    await writer.close()
    await pending
    expect(execute).toHaveBeenCalledWith({ path: 'index', content: 'line\n', mode: 'append' })
    await expect(
      writer.write({ path: 'index', content: 'late\n', mode: 'append' }, execute),
    ).rejects.toThrow('closed')
  })

  it('records physical archive write failure metrics when closing', async () => {
    const driver = mockDriver()
    configureObservability({ driver })
    const writer = new SubagentArchiveWriter({
      queueKey: createCoreInstance(),
      traceRecorder: { recordCompletedSpan: (name, input) => recordCompletedSpan(name, input) },
    }, { sessionId: 'session-1', runId: 'run-1' })

    const firstIndexAppend = writer.write(
      { path: 'index.jsonl', content: 'one\n', mode: 'append' },
      async () => undefined,
      { batchAppend: true },
    )
    const secondIndexAppend = writer.write(
      { path: 'index.jsonl', content: 'two\n', mode: 'append' },
      async () => undefined,
      { batchAppend: true },
    )
    await Promise.all([firstIndexAppend, secondIndexAppend])
    await expect(writer.write(
      { path: 'events.jsonl', content: 'broken\n', mode: 'append' },
      async () => { throw new Error('disk full') },
    )).rejects.toThrow('disk full')
    await writer.close()
    await flushObservability()

    expect(driver.spans).toContainEqual(expect.objectContaining({
      name: 'subagent.archive_write_summary',
      kind: 'internal',
      status: 'error',
      attrs: {
        sessionId: 'session-1',
        runId: 'run-1',
        archive_write_attempts: 2,
        archive_write_failures: 1,
        archive_write_failure_rate: 0.5,
      },
    }))
  })
})
