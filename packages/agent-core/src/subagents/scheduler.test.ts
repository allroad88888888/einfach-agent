import { describe, expect, it } from 'vitest'
import { createSubagentScheduler, subagentScheduler } from './scheduler'
import { defaultCore } from '../runtime/core/coreInstance'

describe('subagent scheduler dispatch accounting', () => {
  it('increments dispatchCounter per reservation batch and keeps child paths monotonic', () => {
    const scheduler = createSubagentScheduler()

    const firstBatch = scheduler.reserveChildren({
      treeId: 'run-1',
      sessionId: 'session-1',
      delegationCallId: 'delegate-1',
      parentPath: 'root',
      inheritedSkillFiles: ['inherited.md'],
      inheritedSkillIds: ['sk_inherited'],
      children: [{ objective: 'a' }, { objective: 'b' }],
    })

    expect(firstBatch.map((node) => node.path)).toEqual(['root-01', 'root-02'])
    expect(firstBatch.map((node) => node.delegationCallId)).toEqual(['delegate-1', 'delegate-1'])
    expect(firstBatch[0].dispatchCounter).toBe(0)
    expect(firstBatch[1].dispatchCounter).toBe(0)

    const secondBatch = scheduler.reserveChildren({
      treeId: 'run-1',
      sessionId: 'session-1',
      parentPath: 'root',
      inheritedSkillFiles: ['inherited.md'],
      inheritedSkillIds: ['sk_inherited'],
      children: [{ objective: 'c' }],
    })

    expect(secondBatch.map((node) => node.path)).toEqual(['root-03'])
    expect(secondBatch[0].dispatchCounter).toBe(0)

    const root = scheduler.snapshot('run-1').find((node) => node.path === 'root')
    expect(root?.childCounter).toBe(3)
    expect(root?.dispatchCounter).toBe(2)
  })

  it('tracks dispatch counters independently per parent', () => {
    const scheduler = createSubagentScheduler()

    scheduler.reserveChildren({
      treeId: 'run-2',
      sessionId: 'session-1',
      parentPath: 'root',
      inheritedSkillFiles: [],
      inheritedSkillIds: [],
      children: [{ objective: 'a' }],
    })

    const rootChildren = scheduler.reserveChildren({
      treeId: 'run-2',
      sessionId: 'session-1',
      parentPath: 'root',
      inheritedSkillFiles: [],
      inheritedSkillIds: [],
      children: [{ objective: 'b' }],
    })

    const childOne = scheduler.reserveChildren({
      treeId: 'run-2',
      sessionId: 'session-1',
      parentPath: rootChildren[0].path,
      inheritedSkillFiles: ['a.md'],
      inheritedSkillIds: ['sk-a'],
      children: [{ objective: 'c' }],
    })

    const childTwo = scheduler.reserveChildren({
      treeId: 'run-2',
      sessionId: 'session-1',
      parentPath: rootChildren[0].path,
      inheritedSkillFiles: ['a.md'],
      inheritedSkillIds: ['sk-a'],
      children: [{ objective: 'd' }],
    })

    expect(rootChildren[0].dispatchCounter).toBe(0)
    expect(childOne[0].dispatchCounter).toBe(0)
    expect(childTwo[0].dispatchCounter).toBe(0)
    expect(childOne[0].path).toBe(`${rootChildren[0].path}-01`)
    expect(childTwo[0].path).toBe(`${rootChildren[0].path}-02`)

    const root = scheduler.snapshot('run-2').find((node) => node.path === 'root')
    const parent = scheduler.snapshot('run-2').find((node) => node.path === rootChildren[0].path)
    expect(root?.dispatchCounter).toBe(2)
    expect(parent?.dispatchCounter).toBe(2)
    expect(parent?.childCounter).toBe(2)
  })

  it('keeps the legacy scheduler export as a defaultCore proxy', () => {
    const treeId = 'legacy-scheduler-proxy'
    subagentScheduler.clear(treeId)

    try {
      subagentScheduler.reserveChildren({
        treeId,
        sessionId: 'session-default',
        parentPath: 'root',
        inheritedSkillFiles: [],
        inheritedSkillIds: [],
        children: [{ objective: 'default-only' }],
      })

      expect(defaultCore.subagentScheduler.snapshot(treeId).map((node) => node.objective)).toEqual([
        'root agent',
        'default-only',
      ])
    } finally {
      subagentScheduler.clear(treeId)
    }
  })
})
