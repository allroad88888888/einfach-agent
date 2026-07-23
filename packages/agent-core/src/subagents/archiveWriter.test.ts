import { describe, expect, it, vi } from 'vitest'
import { SubagentArchiveWriter, type SubagentArchiveWriteInput } from './archiveWriter'

describe('SubagentArchiveWriter', () => {
  it('batches concurrent index appends into one write', async () => {
    const writes: SubagentArchiveWriteInput[] = []
    const execute = vi.fn(async (input: SubagentArchiveWriteInput) => { writes.push(input) })
    const writer = new SubagentArchiveWriter()

    const first = writer.write(
      { path: '.agent-archive/index/skills.jsonl', content: 'one\n', mode: 'append' },
      execute,
      { batchAppend: true },
    )
    const second = writer.write(
      { path: '.agent-archive/index/skills.jsonl', content: 'two\n', mode: 'append' },
      execute,
      { batchAppend: true },
    )
    await Promise.all([first, second, writer.flush()])

    expect(writes).toEqual([
      { path: '.agent-archive/index/skills.jsonl', content: 'one\ntwo\n', mode: 'append' },
    ])
  })

  it('serializes concurrent writes to one path without blocking another path', async () => {
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const order: string[] = []
    const writer = new SubagentArchiveWriter()
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

  it('shares the same-path lock across runtime writer instances', async () => {
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const order: string[] = []
    const firstWriter = new SubagentArchiveWriter()
    const secondWriter = new SubagentArchiveWriter()
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

  it('propagates a batched flush failure to every caller and flush', async () => {
    const failure = new Error('disk full')
    const writer = new SubagentArchiveWriter()
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
    const writer = new SubagentArchiveWriter()

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
    const writer = new SubagentArchiveWriter()
    const pending = writer.write({ path: 'index', content: 'line\n', mode: 'append' }, execute, { batchAppend: true })

    await writer.close()
    await pending
    expect(execute).toHaveBeenCalledWith({ path: 'index', content: 'line\n', mode: 'append' })
    await expect(
      writer.write({ path: 'index', content: 'late\n', mode: 'append' }, execute),
    ).rejects.toThrow('closed')
  })
})
