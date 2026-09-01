import { describe, expect, it, vi } from 'vitest'
import type { AgentHistoryTarget, AgentRolloutDriver, AgentRolloutMutationV1 } from '../history'
import { createChildRolloutRecorder } from './childRolloutRecorder'

function appendMock(implementation: AgentRolloutDriver['append'] = async () => ({ records: [] })) {
  return vi.fn<AgentRolloutDriver['append']>(implementation)
}

function testDriver(append = appendMock()): AgentRolloutDriver {
  return {
    append,
    reconcile: vi.fn(async () => ({ histories: [] })),
    flush: vi.fn(async () => undefined),
  }
}

function firstItemOrdinal(mutations: readonly AgentRolloutMutationV1[]): number {
  const mutation = mutations[0]
  if (mutation?.mutationType !== 'item_upsert') throw new Error('expected item_upsert')
  return mutation.itemOrdinal
}

function childTargetPath(target: AgentHistoryTarget): string {
  if (target.kind !== 'child') throw new Error('expected child target')
  return target.agentPath
}

describe('childRolloutRecorder', () => {
  it('allocates stable item ids and continuous ordinals for one child target', async () => {
    const append = appendMock()
    const driver = testDriver(append)
    const recorder = createChildRolloutRecorder({
      driver, conversationId: 'conversation', runId: 'run', agentPath: 'root-01', now: () => 42,
    })

    await recorder.recordInitial([
      { role: 'system', content: 'system' },
      { role: 'user', content: 'user' },
    ])
    await recorder.recordItem({ role: 'assistant', content: 'answer' })
    await recorder.recordSuccess()

    const mutations = append.mock.calls.flatMap((call) => call[1] as AgentRolloutMutationV1[])
    const items = mutations.filter((mutation) => mutation.mutationType === 'item_upsert')
    const target: AgentHistoryTarget = {
      kind: 'child', conversationId: 'conversation', runId: 'run', agentPath: 'root-01',
    }
    expect(items.map((item) => [item.itemId, item.itemOrdinal])).toEqual([
      ['run:root-01:0', 0], ['run:root-01:1', 1], ['run:root-01:2', 2],
    ])
    expect(mutations.map((mutation) => mutation.target)).toEqual(
      mutations.map(() => target),
    )
    expect(driver.flush).toHaveBeenCalledOnce()
  })

  it('does not advance an item ordinal when the strong append fails', async () => {
    const append = appendMock()
      .mockRejectedValueOnce(new Error('disk unavailable'))
      .mockResolvedValue({ records: [] })
    const recorder = createChildRolloutRecorder({
      driver: testDriver(append), conversationId: 'c', runId: 'r', agentPath: 'root-02',
    })

    await expect(recorder.recordItem({ role: 'user', content: 'retry me' }))
      .rejects.toThrow('disk unavailable')
    await recorder.recordItem({ role: 'user', content: 'retry me' })

    expect(append.mock.calls.map((call) => firstItemOrdinal(call[1]))).toEqual([0, 0])
  })

  it('is an explicit no-op when no driver is configured', async () => {
    const recorder = createChildRolloutRecorder({
      conversationId: 'c', runId: 'r', agentPath: 'root-03',
    })
    await recorder.recordInitial([{ role: 'system', content: 'system' }])
    await recorder.recordItem({ role: 'assistant', content: 'done' })
    await recorder.recordSuccess()
  })

  it('keeps sibling and nested targets on independent ordinal sequences', async () => {
    const append = appendMock()
    const driver = testDriver(append)
    const paths = ['root-01', 'root-02', 'root-01-01']
    for (const agentPath of paths) {
      const recorder = createChildRolloutRecorder({
        driver, conversationId: 'c', runId: 'r', agentPath,
      })
      await recorder.recordItem({ role: 'user', content: agentPath })
    }

    expect(append.mock.calls.map((call) => ({
      path: childTargetPath(call[0]),
      ordinal: firstItemOrdinal(call[1]),
    }))).toEqual(paths.map((path) => ({ path, ordinal: 0 })))
  })

  it.each(['failed', 'cancelled'] as const)(
    'settles %s without surfacing terminal append or flush failures', async (status) => {
      const driver = testDriver(appendMock(async () => { throw new Error('terminal failed') }))
      vi.mocked(driver.flush).mockRejectedValue(new Error('flush failed'))
      const recorder = createChildRolloutRecorder({
        driver, conversationId: 'c', runId: 'r', agentPath: 'root-04',
      })

      await expect(recorder.settleFailure(status, 'original failure')).resolves.toBeUndefined()
      expect(driver.append).toHaveBeenCalledOnce()
      expect(driver.flush).toHaveBeenCalledOnce()
    },
  )
})
