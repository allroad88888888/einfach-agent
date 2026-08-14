import { describe, expect, it, vi } from 'vitest'
import { createCoreInstance } from '../runtime/core/coreInstance'
import type { RecoveryWriteOutcome } from '../runtime/recoveryWriter'
import { subagentContinuationsAtom } from '../state/subagentContinuationAtoms'
import {
  persistChildExecutionFence,
  persistQueuedChildContinuations,
  persistTerminalChildResults,
} from './continuationLifecycle'
import type { DelegateAgentChildSpec, SubagentNodeRecord } from './types'

const sessionId = 'session-1'
const task: DelegateAgentChildSpec = { objective: 'perform one isolated check' }

function node(path = 'root-01'): SubagentNodeRecord {
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

function failedOutcomes(): RecoveryWriteOutcome[] {
  return [
    { status: 'error', sessionId, error: new Error('stale recovery write') },
    { status: 'tombstoned', sessionId },
    { status: 'skipped', sessionId, reason: 'reset' },
  ]
}

describe('child continuation recovery persistence fences', () => {
  it.each(failedOutcomes())('does not return a queue token after $status persistence', async (outcome) => {
    const core = createCoreInstance()
    vi.spyOn(core.persistence, 'persistRecovery').mockResolvedValue(outcome)
    const runChild = vi.fn()

    await expect(persistQueuedChildContinuations({ core, sessionId, nodes: [node()], specs: [task] })).rejects
      .toThrow('recovery persistence did not save children queued')
    expect(runChild).not.toHaveBeenCalled()
  })

  it.each(failedOutcomes())('does not permit a child runner after $status execution fence', async (outcome) => {
    const core = createCoreInstance()
    const batch = await persistQueuedChildContinuations({ core, sessionId, nodes: [node()], specs: [task] })
    vi.spyOn(core.persistence, 'persistRecovery').mockResolvedValue(outcome)
    const runChild = vi.fn()

    await expect(persistChildExecutionFence({ core, sessionId, childId: node().id, queuedBatch: batch })).rejects
      .toThrow('recovery persistence did not save child execution fence')
    expect(runChild).not.toHaveBeenCalled()
  })

  it('accepts an unconfigured bridge and a saved recovery record before child work', async () => {
    const core = createCoreInstance()
    const child = node()
    const batch = await persistQueuedChildContinuations({ core, sessionId, nodes: [child], specs: [task] })
    await expect(persistChildExecutionFence({ core, sessionId, childId: child.id, queuedBatch: batch })).resolves.toBeUndefined()

    const savedCore = createCoreInstance()
    const saved: RecoveryWriteOutcome = { status: 'saved', sessionId, generation: 3, attempts: 1 }
    const persist = vi.spyOn(savedCore.persistence, 'persistRecovery').mockResolvedValue(saved)
    const savedChild = node('root-02')
    const savedBatch = await persistQueuedChildContinuations({
      core: savedCore, sessionId, nodes: [savedChild], specs: [task],
    })
    await persistChildExecutionFence({
      core: savedCore, sessionId, childId: savedChild.id, queuedBatch: savedBatch,
    })

    expect(persist).toHaveBeenNthCalledWith(1, sessionId, 'subagent.children_queued')
    expect(persist).toHaveBeenNthCalledWith(2, sessionId, 'subagent.child_outcome_unknown')
  })

  it.each(failedOutcomes())('retains terminal facts but cannot deliver them after $status persistence', async (outcome) => {
    const core = createCoreInstance()
    const child = node()
    await persistQueuedChildContinuations({ core, sessionId, nodes: [child], specs: [task] })
    vi.spyOn(core.persistence, 'persistRecovery').mockResolvedValue(outcome)
    const deliverToParent = vi.fn()
    let delivered = false

    try {
      await persistTerminalChildResults({
        core,
        sessionId,
        children: [{
          childId: child.id,
          kind: 'done',
          summary: 'finished',
          resultArchivePath: 'archive/result.md',
          skillFiles: [],
          skillIds: [],
          changeSets: [],
        }],
      })
      delivered = true
      deliverToParent()
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain('recovery persistence did not save child terminal')
    }

    expect(delivered).toBe(false)
    expect(deliverToParent).not.toHaveBeenCalled()
    expect(core.getSessionStore(sessionId).store.getter(subagentContinuationsAtom)).toMatchObject([{
      childId: child.id,
      state: 'interrupted',
      spec: { lifecycle: 'terminal', terminal: { resultArchivePath: 'archive/result.md' } },
    }])
  })
})
