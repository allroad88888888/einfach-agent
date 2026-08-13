import { describe, expect, it } from 'vitest'
import { createDelegationAssembly } from './delegationAssembly'

describe('createDelegationAssembly', () => {
  it('gives every assembly an independent scheduler', () => {
    const first = createDelegationAssembly()
    const second = createDelegationAssembly()

    first.scheduler.reserveChildren({
      treeId: 'run-first',
      sessionId: 'session-first',
      parentPath: 'root',
      inheritedSkillFiles: [],
      inheritedSkillIds: [],
      children: [{ objective: 'first only' }],
    })

    expect(first.scheduler.snapshot('run-first').map((node) => node.path)).toEqual(['root', 'root-01'])
    expect(second.scheduler.snapshot('run-first')).toEqual([])
  })
})
