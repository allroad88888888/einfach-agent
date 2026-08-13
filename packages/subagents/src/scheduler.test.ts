import { describe, expect, it } from 'vitest'
import { createSubagentScheduler } from './scheduler'

describe('createSubagentScheduler', () => {
  it('reserves siblings under the root in dispatch order', () => {
    const scheduler = createSubagentScheduler()

    const nodes = scheduler.reserveChildren({
      treeId: 'tree-a',
      sessionId: 'session-a',
      parentPath: 'root',
      inheritedSkillFiles: ['skills/root.md'],
      inheritedSkillIds: ['root-skill'],
      children: [
        { objective: 'first child' },
        { objective: 'second child' },
      ],
    })

    expect(nodes.map((node) => node.path)).toEqual(['root-01', 'root-02'])
    expect(nodes.map((node) => node.delegationCallId)).toEqual([undefined, undefined])
    expect(nodes[0]?.inheritedSkillIds).toEqual(['root-skill'])
  })

  it('keeps parent dispatch counters local to each tree', () => {
    const scheduler = createSubagentScheduler()
    const baseInput = {
      sessionId: 'session-a',
      parentPath: 'root-03',
      inheritedSkillFiles: [],
      inheritedSkillIds: [],
      children: [{ objective: 'child' }],
    }

    expect(scheduler.reserveChildren({ ...baseInput, treeId: 'tree-a' })[0]?.path).toBe('root-03-01')
    expect(scheduler.reserveChildren({ ...baseInput, treeId: 'tree-a' })[0]?.path).toBe('root-03-02')
    expect(scheduler.reserveChildren({ ...baseInput, treeId: 'tree-b' })[0]?.path).toBe('root-03-01')
  })
})
