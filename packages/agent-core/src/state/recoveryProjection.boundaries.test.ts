// 投影的写入边界：单个 Einfach 批次、allowlist 之外一律不碰、store 之间互不串。
// 逐值往返与 fail-closed 见 recoveryProjection.test.ts。

import { createStore } from '@einfach/core'
import { describe, expect, it } from 'vitest'
import { executionEventsAtom } from '../execution/graph'
import { applyRecoverySnapshot } from './recoveryProjection'
import {
  checkpointsAtom,
  currentTurnIndexAtom,
  itemsAtom,
  planAtom,
  runAtom,
} from './sessionAtoms'
import {
  alwaysAllowedToolsAtom,
  assistantStreamAtom,
  browserCardsAtom,
  pendingQuestionAnswersAtom,
  toolActivityAtom,
} from './sessionTransientAtoms'
import { subagentContinuationsAtom } from './subagentContinuationAtoms'
import { capture, seedDurableState } from './recoveryProjection.fixtures'

describe('recoveryProjection boundaries', () => {
  it('publishes recovery as one coherent Einfach update', () => {
    const source = createStore()
    const target = createStore()
    seedDurableState(source)
    const snapshot = capture(source)
    const observed: Array<{ planId: string | undefined; runId: string | undefined; answer: unknown }> = []
    const unsubscribe = target.sub(itemsAtom, () => {
      observed.push({
        planId: target.getter(planAtom)?.id,
        runId: target.getter(runAtom)?.runId,
        answer: target.getter(pendingQuestionAnswersAtom)['ask-1'],
      })
    })

    applyRecoverySnapshot(target, snapshot)
    unsubscribe()

    expect(observed).toEqual([{ planId: 'plan-1', runId: 'run-1', answer: ['first', 'second'] }])
  })

  it('leaves derived, UI, history, and safety atoms outside the allowlist untouched', () => {
    const source = createStore()
    const target = createStore()
    seedDurableState(source)
    target.setter(checkpointsAtom, [{ turnIndex: 1, label: 'keep', createdAt: 1, items: [] }])
    target.setter(currentTurnIndexAtom, 1)
    target.setter(browserCardsAtom, [{ id: 'card-1', createdAt: 1, title: 'keep card' }])
    target.setter(assistantStreamAtom, {
      runId: 'ui-run',
      item: { id: 'stream-1', createdAt: 1, item: { role: 'assistant', content: 'keep stream' } },
    })
    target.setter(toolActivityAtom, [{ callId: 'tool-1', toolName: 'write_file', text: 'running' }])
    target.setter(alwaysAllowedToolsAtom, ['write_file'])
    target.setter(executionEventsAtom, [{ type: 'graph.hydrated', at: 1 }])

    applyRecoverySnapshot(target, capture(source))

    expect(target.getter(checkpointsAtom)).toHaveLength(1)
    expect(target.getter(currentTurnIndexAtom)).toBe(1)
    expect(target.getter(browserCardsAtom)).toHaveLength(1)
    expect(target.getter(assistantStreamAtom)?.runId).toBe('ui-run')
    expect(target.getter(toolActivityAtom)).toEqual([{ callId: 'tool-1', toolName: 'write_file', text: 'running' }])
    expect(target.getter(alwaysAllowedToolsAtom)).toEqual(['write_file'])
    expect(target.getter(executionEventsAtom)).toEqual([{ type: 'graph.hydrated', at: 1 }])
  })

  it('keeps recovery projection and its sole child continuation atom isolated per store', () => {
    const first = createStore()
    const second = createStore()
    seedDurableState(first)
    second.setter(subagentContinuationsAtom, [{
      schemaVersion: 1,
      childId: 'child-2',
      parentRunId: 'run-2',
      parentNodeId: null,
      state: 'queued',
      spec: { task: 'other session' },
    }])

    const snapshot = capture(first)
    applyRecoverySnapshot(first, snapshot)

    expect(second.getter(itemsAtom)).toEqual([])
    expect(second.getter(subagentContinuationsAtom)).toEqual([{
      schemaVersion: 1,
      childId: 'child-2',
      parentRunId: 'run-2',
      parentNodeId: null,
      state: 'queued',
      spec: { task: 'other session' },
    }])
    expect(snapshot).not.toHaveProperty('continuation')
    expect(snapshot.values.subagentContinuations).toEqual(first.getter(subagentContinuationsAtom))
  })
})
