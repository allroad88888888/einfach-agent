import { describe, expect, it, vi } from 'vitest'
import { createCoreInstance } from '../runtime/core/coreInstance'
import { subagentContinuationsAtom } from '../state/subagentContinuationAtoms'
import {
  childContinuationDescriptorJson,
  createChildContinuationDescriptor,
  terminalChildContinuationDescriptor,
} from './continuationDescriptor'
import { parseChildContinuation } from './continuationDescriptorParser'
import {
  fenceChildContinuation,
  markChildContinuationTerminal,
  queueChildContinuations,
} from './continuationStore'
import type { DelegateAgentChildSpec, SubagentNodeRecord } from './types'

const sessionId = 'session-1'
const task: DelegateAgentChildSpec = { objective: 'inspect the work' }

function node(path: string): SubagentNodeRecord {
  return {
    id: `run-1:${path}`,
    treeId: 'run-1',
    sessionId,
    path,
    parentPath: 'root',
    delegationCallId: 'delegate-call-1',
    status: 'queued',
    objective: task.objective,
    depth: 1,
    dispatchCounter: 0,
    childCounter: 0,
    createdAt: 1,
    updatedAt: 1,
    inheritedSkillFiles: [],
    inheritedSkillIds: [],
    localSkillFiles: [],
    localSkillIds: [],
  }
}

function storeFor() {
  const core = createCoreInstance()
  return { core, store: core.getSessionStore(sessionId).store }
}

describe('subagent continuation store', () => {
  it('fences only a freshly queued child once before work starts', () => {
    const { core, store } = storeFor()
    const child = node('root-01')
    const batch = queueChildContinuations({ core, sessionId, nodes: [child], specs: [task] })

    expect(store.getter(subagentContinuationsAtom)).toMatchObject([{ childId: child.id, state: 'queued' }])
    expect(fenceChildContinuation({ core, sessionId, childId: child.id, queuedBatch: batch })).toBe(true)
    expect(fenceChildContinuation({ core, sessionId, childId: child.id, queuedBatch: batch })).toBe(false)
    expect(store.getter(subagentContinuationsAtom)).toMatchObject([{ childId: child.id, state: 'outcome_unknown' }])
  })

  it('cannot use a fresh token to rerun restored queued, unknown, or terminal work', () => {
    const { core, store } = storeFor()
    const queued = node('root-01')
    const unknown = node('root-02')
    const terminal = node('root-03')
    const descriptor = createChildContinuationDescriptor(terminal, task)
    store.setter(subagentContinuationsAtom, [
      { schemaVersion: 1, childId: queued.id, parentRunId: 'run-1', parentNodeId: null, state: 'queued', spec: childContinuationDescriptorJson(createChildContinuationDescriptor(queued, task)) },
      { schemaVersion: 1, childId: unknown.id, parentRunId: 'run-1', parentNodeId: null, state: 'outcome_unknown', spec: childContinuationDescriptorJson(createChildContinuationDescriptor(unknown, task)) },
      {
        schemaVersion: 1, childId: terminal.id, parentRunId: 'run-1', parentNodeId: null, state: 'interrupted',
        spec: childContinuationDescriptorJson(terminalChildContinuationDescriptor({
          descriptor, kind: 'done', summary: 'done', resultArchivePath: 'archive/result.md',
          skillFiles: [], skillIds: [], changeSets: [],
        })),
      },
    ])
    const currentBatch = queueChildContinuations({ core, sessionId, nodes: [node('root-04')], specs: [task] })
    const runChild = vi.fn()

    for (const continuation of store.getter(subagentContinuationsAtom).slice(0, 3)) {
      if (fenceChildContinuation({ core, sessionId, childId: continuation.childId, queuedBatch: currentBatch })) {
        runChild(continuation.childId)
      }
    }

    expect(runChild).not.toHaveBeenCalled()
    expect(store.getter(subagentContinuationsAtom).slice(0, 3).map(parseChildContinuation)).toEqual([
      { kind: 'requires_reconciliation', reason: 'child execution requires reconciliation' },
      { kind: 'requires_reconciliation', reason: 'child execution requires reconciliation' },
      { kind: 'deliver_terminal' },
    ])
  })

  it('retains terminal output and correlation until a later parent aggregation boundary', () => {
    const { core, store } = storeFor()
    const child = node('root-01')
    queueChildContinuations({ core, sessionId, nodes: [child], specs: [task] })

    markChildContinuationTerminal({
      core, sessionId, childId: child.id, kind: 'done', summary: 'completed',
      resultArchivePath: 'archive/result.md', skillFiles: ['skills/summary.md'], skillIds: ['skill-1'],
      changeSets: [{ id: 'change-1', reversible: true }],
    })

    expect(store.getter(subagentContinuationsAtom)).toMatchObject([{
      childId: child.id,
      state: 'interrupted',
      spec: {
        parent: { path: 'root', delegationCallId: 'delegate-call-1' },
        lifecycle: 'terminal',
        terminal: { resultArchivePath: 'archive/result.md' },
      },
    }])
  })
})
