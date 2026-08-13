import { describe, expect, it } from 'vitest'
// 本文件的标的就是**产品装配**：前两条用例测 `@web-agent/subagents` 的调度器派发计数，
// 最后一条测 `subagentScheduler` 这个兼容代理确实转发到 defaultCore 上装配的那颗调度器。
// 因此这里刻意保留对产品包的依赖——换成 core 侧的假调度器就没有任何东西被测到了。
import { createDelegationAssembly, createSubagentScheduler } from '@web-agent/subagents'
import { configureDefaultDelegation, defaultCore } from '../runtime/core/coreInstance'
import { subagentScheduler } from './scheduler'

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
    configureDefaultDelegation(null)
    expect(() => subagentScheduler.snapshot(treeId)).toThrow('默认 Core 未注入子 Agent 委派能力')
    configureDefaultDelegation(createDelegationAssembly)

    try {
      subagentScheduler.reserveChildren({
        treeId,
        sessionId: 'session-default',
        parentPath: 'root',
        inheritedSkillFiles: [],
        inheritedSkillIds: [],
        children: [{ objective: 'default-only' }],
      })

      expect(defaultCore.delegation!.scheduler.snapshot(treeId).map((node) => node.objective)).toEqual([
        'root agent',
        'default-only',
      ])
    } finally {
      subagentScheduler.clear(treeId)
      configureDefaultDelegation(null)
    }
  })
})
