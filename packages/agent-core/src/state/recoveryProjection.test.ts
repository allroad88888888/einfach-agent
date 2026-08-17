// 投影的值语义：allowlist 逐值往返、缺省值编码、克隆隔离与非法值 fail-closed。
// 批次/隔离等写入边界见 recoveryProjection.boundaries.test.ts。

import { createStore } from '@einfach/core'
import { describe, expect, it } from 'vitest'
import { executionGraphAtom } from '../execution/graph'
import { applyRecoverySnapshot } from './recoveryProjection'
import {
  contextCheckpointAtom,
  itemsAtom,
  planAtom,
  planStageCheckpointsAtom,
  runAtom,
} from './sessionAtoms'
import {
  pendingArtifactsAtom,
  pendingQuestionAnswersAtom,
  queuedUserMessagesAtom,
} from './sessionTransientAtoms'
import { subagentContinuationsAtom } from './subagentContinuationAtoms'
import { capture, recoverySession, seedDurableState } from './recoveryProjection.fixtures'

describe('recoveryProjection values', () => {
  it('round-trips every allowlisted durable value and excludes pendingExecutionId', () => {
    const source = createStore()
    const target = createStore()
    seedDurableState(source)

    const snapshot = capture(source)
    applyRecoverySnapshot(target, snapshot)

    expect(snapshot.session).toEqual(recoverySession)
    expect(snapshot.values.run).not.toHaveProperty('pendingExecutionId')
    expect(target.getter(itemsAtom)).toEqual(snapshot.values.conversation.items)
    expect(target.getter(contextCheckpointAtom)).toEqual(snapshot.values.conversation.contextCheckpoint)
    expect(target.getter(planAtom)).toEqual(snapshot.values.plan.current)
    expect(target.getter(planStageCheckpointsAtom)).toEqual(snapshot.values.plan.stageCheckpoints)
    expect(target.getter(runAtom)).toEqual(snapshot.values.run)
    expect(target.getter(queuedUserMessagesAtom)).toEqual(snapshot.values.queuedUserMessages)
    expect(target.getter(pendingQuestionAnswersAtom)).toEqual({ 'ask-1': ['first', 'second'] })
    expect(target.getter(executionGraphAtom)).toEqual(snapshot.values.executionGraph)
    expect(target.getter(subagentContinuationsAtom)).toEqual(snapshot.values.subagentContinuations)
  })

  // save_file 只把 artifactId/字节数回给模型，content 不进 transcript：这个 atom 是唯一副本。
  it('restores pending artifact content that exists nowhere else', () => {
    const source = createStore()
    const target = createStore()
    seedDurableState(source)

    const snapshot = capture(source)
    applyRecoverySnapshot(target, snapshot)

    expect(target.getter(pendingArtifactsAtom)).toEqual([{
      id: 'artifact-1',
      filename: 'report.md',
      content: '# 只活在这个 atom 里的产物内容',
      mimeType: 'text/markdown',
    }])
  })

  it('uses null for absent durable atom values and restores them as undefined', () => {
    const source = createStore()
    const target = createStore()
    const snapshot = capture(source)

    expect(snapshot.values.conversation.contextCheckpoint).toBeNull()
    expect(snapshot.values.plan.current).toBeNull()
    expect(snapshot.values.run).toBeNull()
    expect(snapshot.values.pendingArtifacts).toEqual([])

    seedDurableState(target)
    applyRecoverySnapshot(target, snapshot)
    expect(target.getter(contextCheckpointAtom)).toBeUndefined()
    expect(target.getter(planAtom)).toBeUndefined()
    expect(target.getter(runAtom)).toBeUndefined()
    expect(target.getter(pendingArtifactsAtom)).toEqual([])
  })

  it('JSON-clones a captured projection before a writer can observe later source changes', () => {
    const store = createStore()
    seedDurableState(store)
    const snapshot = capture(store)

    expect(snapshot.values.conversation.items).not.toBe(store.getter(itemsAtom))
    expect(snapshot.values.pendingQuestionAnswers).not.toBe(store.getter(pendingQuestionAnswersAtom))
    expect(snapshot.values.pendingArtifacts).not.toBe(store.getter(pendingArtifactsAtom))
    expect(snapshot.values.executionGraph).not.toBe(store.getter(executionGraphAtom))
    expect(snapshot.values.subagentContinuations).not.toBe(store.getter(subagentContinuationsAtom))

    store.setter(itemsAtom, [])
    store.setter(pendingQuestionAnswersAtom, {})
    store.setter(pendingArtifactsAtom, [])
    expect(snapshot.values.conversation.items).toHaveLength(1)
    expect(snapshot.values.pendingQuestionAnswers).toEqual({ 'ask-1': ['first', 'second'] })
    expect(snapshot.values.pendingArtifacts).toHaveLength(1)
  })

  it('rejects function and cycle values before capture or atomic apply can alter state', () => {
    const malformed = createStore()
    malformed.setter(runAtom, { runId: 'bad', status: 'waiting_user', pendingQuestion: () => undefined })
    expect(() => capture(malformed)).toThrow('Recovery projection does not satisfy')
    const cycle: { self?: unknown } = {}
    cycle.self = cycle
    malformed.setter(runAtom, { runId: 'bad', status: 'waiting_user', pendingQuestion: cycle })
    expect(() => capture(malformed)).toThrow('Recovery projection does not satisfy')

    const source = createStore()
    const target = createStore()
    seedDurableState(source)
    target.setter(itemsAtom, [{ id: 'preserve', createdAt: 1, item: { role: 'user', content: 'unchanged' } }])
    const functionSnapshot = capture(source)
    functionSnapshot.values.run!.pendingQuestion = () => undefined
    const cycleSnapshot = capture(source)
    cycleSnapshot.values.run!.pendingQuestion = cycle

    expect(() => applyRecoverySnapshot(target, functionSnapshot)).toThrow('Cannot apply an invalid')
    expect(() => applyRecoverySnapshot(target, cycleSnapshot)).toThrow('Cannot apply an invalid')
    expect(target.getter(itemsAtom)).toEqual([{ id: 'preserve', createdAt: 1, item: { role: 'user', content: 'unchanged' } }])
  })
})
