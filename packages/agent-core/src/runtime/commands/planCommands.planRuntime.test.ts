import { describe, expect, it, vi } from 'vitest'
import { activeSessionIdAtom, sessionsAtom } from '../../state/rootStore'
import { itemsAtom, runAtom } from '../../state/sessionAtoms'
import { createCoreInstance } from '../core/coreInstance'
import { createPlanCommands } from './planCommands'

describe('planCommands 的 planRuntime 槽', () => {
  it('未注入时回退计划阶段不会崩溃，并写入中文提示', () => {
    const core = createCoreInstance({ planRuntime: null })
    const sessionId = 'session-1'
    core.rootStore.setter(sessionsAtom, {
      [sessionId]: {
        id: sessionId,
        title: '测试会话',
        settings: { vendor: 'deepseek', model: 'test' },
        createdAt: 0,
        updatedAt: 0,
      },
    })
    core.rootStore.setter(activeSessionIdAtom, sessionId)
    const stopRun = vi.fn()

    expect(() => createPlanCommands(core, stopRun).rollbackPlanStage('plan-1', 1, 'stage-1')).not.toThrow()
    expect(stopRun).not.toHaveBeenCalled()
    expect(core.getSessionStore(sessionId).store.getter(itemsAtom).at(-1)?.item).toMatchObject({
      role: 'assistant',
      content: '当前运行环境未装配计划能力，无法回退计划阶段。',
    })
  })

  it('未注入时审批计划会返回中文错误并恢复暂停的运行', () => {
    const core = createCoreInstance({ planRuntime: null })
    const sessionId = 'session-1'
    core.rootStore.setter(sessionsAtom, {
      [sessionId]: {
        id: sessionId,
        title: '测试会话',
        settings: { vendor: 'deepseek', model: 'test' },
        createdAt: 0,
        updatedAt: 0,
      },
    })
    core.rootStore.setter(activeSessionIdAtom, sessionId)
    core.getSessionStore(sessionId).store.setter(runAtom, {
      runId: 'run-1',
      status: 'waiting_plan_approval',
      pendingPlanApproval: { callId: 'call-1', planId: 'plan-1', revision: 1 },
    })

    expect(() => createPlanCommands(core, vi.fn()).approvePlan(true)).not.toThrow()
    expect(core.getSessionStore(sessionId).store.getter(itemsAtom).at(-1)?.item).toMatchObject({
      role: 'tool',
      tool_call_id: 'call-1',
      content: JSON.stringify({ error: '当前运行环境未装配计划能力，无法审批计划。' }),
    })
    expect(core.getSessionStore(sessionId).store.getter(runAtom)?.pendingPlanApproval).toBeUndefined()
  })
})
