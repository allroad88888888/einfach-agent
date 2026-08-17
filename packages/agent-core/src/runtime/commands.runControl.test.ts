// P-R3 命令 API 的单测（红→绿）。T3 从 commands.test.ts 拆出：续跑计划 / 中断 / 撤回当前轮。
// ---------------------------------------------------------------------------
// 契约 U1/U2：commands 是 UI ↔ runtime 的唯一边界，且不收 store。
// 本测只断言「编排」：命令是否按约定调用了 beginRun/runSession/endRun/abortRun/
// jumpToCheckpoint，以及是否正确读写 rootStore 和 sessionStore（getSessionStore）。
// 真实 model / abort / checkpoint 全部 mock 掉。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// —— mock runtime 依赖：只验证编排，不跑真实 model / abort / checkpoint。——
vi.mock('./modelRun', () => ({
  runSession: vi.fn(() => Promise.resolve()),
  resumeInterruptedSession: vi.fn(() => Promise.resolve()),
  resumePlanSession: vi.fn(() => Promise.resolve()),
  runToolLoop: vi.fn(() => Promise.resolve()),
}))
vi.mock('../state/checkpointWriters', () => ({
  jumpToCheckpoint: vi.fn(),
  rewindBeforeCheckpoint: vi.fn(),
  revertToPlanStageCheckpoint: vi.fn(),
  updateCheckpoint: vi.fn(),
}))
// D-4：持久化桥全 mock —— 只验证 commands 按约定调用了落盘钩子（不跑真实 IndexedDB）。
vi.mock('./persistenceBridge', () => ({
  persistSessions: vi.fn(),
  persistWorkspaces: vi.fn(),
  persistDeleteSession: vi.fn(),
  persistTruncate: vi.fn(),
  persistCheckpoint: vi.fn(),
}))

import { getSessionStore } from '../state/sessionStore'
import {
  addBrowserCard,
  browserCardsAtom,
  addRuntimeTranscriptEvent,
  runtimeTranscriptEventsAtom,
  composerDraftAtom,
  withdrawnTurnNoticeAtom,
} from '../state/transientAtoms'
import { itemsAtom, runAtom, checkpointsAtom } from '../state/sessionAtoms'
import type { ConversationItem } from '../state/core.type'
import { setPlan, getPlan } from '../state/planWriters'
import { resumeInterruptedSession, resumePlanSession, runSession } from './modelRun'
import { defaultCore, createCoreInstance } from './core/coreInstance'
import { createDefaultPlanRuntime } from '@web-agent/tools-planning'

// C2 后 defaultCore 不再内置 plan runtime（实现在 tools-planning）；本套件的 continuePlan 用例
// 需要真实语义，按 main.tsx 的装配方式在本文件 worker 内注入（isolate:true，不外溢）。
defaultCore.planRuntime = createDefaultPlanRuntime
import { getExecutionRuntime } from '../execution/runtime'
import { executionGraphAtom } from '../execution/graph'
import { rewindBeforeCheckpoint } from '../state/checkpointWriters'
import { persistTruncate } from './persistenceBridge'
import { configureCommands, createCommands, newSession, continuePlan, stopRun, withdrawCurrentTurnToDraft } from './commands'
import { flush, spyOnDefaultAbort, type AbortSpies } from './commands.testHarness'

let beginRun: AbortSpies['beginRun']
let abortRun: AbortSpies['abortRun']
let endRun: AbortSpies['endRun']

beforeEach(() => {
  ;({ beginRun, abortRun, endRun } = spyOnDefaultAbort())
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('commands（P-R3 UI 唯一入口 · 不收 store）', () => {
  it('continuePlan：新版计划 checkpoint 的 interrupted run 转交通用恢复入口', () => {
    const id = newSession()
    setPlan(id, {
      id: 'plan-interrupted', title: '恢复计划', objective: '完成工作', status: 'active', revision: 1,
      requiresApproval: false, createdAt: 1, updatedAt: 2,
      stages: [{
        id: 'implement', title: '实现', objective: '完成代码', deliverables: [],
        dependencies: [], status: 'in_progress', evidence: [],
      }],
    })
    getSessionStore(id).store.setter(runAtom, {
      runId: 'run-before-restart',
      status: 'interrupted',
    })

    continuePlan()

    expect(resumeInterruptedSession).toHaveBeenCalledOnce()
    expect(resumePlanSession).not.toHaveBeenCalled()
  })

  it('continuePlan：对没有运行中 run 的持久化计划直接续跑，不追加新的用户消息', async () => {
    configureCommands({ modelCredentials: { deepseek: 'k' } })
    const id = newSession()
    setPlan(id, {
      id: 'plan-resume', title: '恢复计划', objective: '完成剩余工作', status: 'active', revision: 2,
      requiresApproval: false, createdAt: 1, updatedAt: 2,
      stages: [{
        id: 'implement', title: '实现', objective: '完成代码', deliverables: [],
        dependencies: [], status: 'in_progress', evidence: [],
      }],
    })

    continuePlan()

    expect(resumePlanSession).toHaveBeenCalledOnce()
    expect(vi.mocked(resumePlanSession).mock.calls[0][0]).toBe(id)
    expect(runSession).not.toHaveBeenCalled()
    expect(getSessionStore(id).store.getter(itemsAtom)).toEqual([])
    await flush()
    expect(endRun).toHaveBeenCalledWith(id, expect.anything())
  })

  it('continuePlan：已有挂接中的 run 时不重复续跑', () => {
    const id = newSession()
    setPlan(id, {
      id: 'plan-running', title: '运行计划', objective: '完成工作', status: 'active', revision: 1,
      requiresApproval: false, createdAt: 1, updatedAt: 2,
      stages: [{
        id: 'implement', title: '实现', objective: '完成代码', deliverables: [],
        dependencies: [], status: 'in_progress', evidence: [],
      }],
    })
    getSessionStore(id).store.setter(runAtom, { runId: 'running', status: 'running' })

    continuePlan()

    expect(resumePlanSession).not.toHaveBeenCalled()
    expect(runSession).not.toHaveBeenCalled()
    expect(beginRun).not.toHaveBeenCalled()
  })

  it('continuePlan：中断遗留的 awaiting_tool 会恢复原 run', () => {
    const id = newSession()
    setPlan(id, {
      id: 'plan-orphaned-run', title: '恢复执行', objective: '完成工作', status: 'active', revision: 4,
      requiresApproval: false, createdAt: 1, updatedAt: 2,
      stages: [{
        id: 'implement', title: '实现', objective: '完成代码', deliverables: [],
        dependencies: [], status: 'in_progress', evidence: ['pnpm test'],
      }],
    })
    getSessionStore(id).store.setter(runAtom, { runId: 'orphaned-run', status: 'awaiting_tool' })

    continuePlan()

    expect(resumeInterruptedSession).toHaveBeenCalledOnce()
    expect(resumePlanSession).not.toHaveBeenCalled()
  })

  it('continuePlan：无活跃 run 时沿用原计划续跑，不改动计划状态', () => {
    const id = newSession()
    setPlan(id, {
      id: 'plan-resume', title: '恢复执行', objective: '完成工作', status: 'active', revision: 4,
      requiresApproval: false, createdAt: 1, updatedAt: 2,
      stages: [{
        id: 'implement', title: '实现', objective: '完成代码', deliverables: [],
        dependencies: [], status: 'in_progress', evidence: ['pnpm test'],
      }],
    })

    continuePlan()

    expect(getPlan(id)).toMatchObject({
      revision: 4,
      stages: [{ status: 'in_progress' }],
    })
    expect(resumePlanSession).toHaveBeenCalledOnce()
    expect(runSession).not.toHaveBeenCalled()
  })

  it('continuePlan：活跃或暂停的 run 不重复续跑', () => {
    const id = newSession()
    setPlan(id, {
      id: 'plan-live', title: '正在执行', objective: '完成工作', status: 'active', revision: 4,
      requiresApproval: false, createdAt: 1, updatedAt: 2,
      stages: [{
        id: 'implement', title: '实现', objective: '完成代码', deliverables: [],
        dependencies: [], status: 'in_progress', evidence: ['pnpm test'],
      }],
    })
    const store = getSessionStore(id).store
    for (const status of [
      'running',
      'awaiting_tool',
      'waiting_user',
      'waiting_confirmation',
      'waiting_plan_approval',
    ] as const) {
      store.setter(runAtom, {
        runId: `run-${status}`,
        status,
        ...(status === 'awaiting_tool' ? { pendingExecutionId: 'still-running' } : {}),
      })
      continuePlan()
    }

    expect(getPlan(id)?.revision).toBe(4)
    expect(resumePlanSession).not.toHaveBeenCalled()
  })

  it('stopRun：中断当前 active 会话的 run', () => {
    const id = newSession()
    stopRun()
    expect(abortRun).toHaveBeenCalledWith(id)
  })

  it('stopRun：awaiting_tool 即使来自旧状态且没有 execution id，也会停止 run 与后台子执行', async () => {
    const core = createCoreInstance()
    const commands = createCommands(core)
    const id = commands.newSession()
    const store = core.getSessionStore(id).store
    const execution = getExecutionRuntime(core)
    const handle = execution.spawn({
      sessionId: id,
      runId: 'run-awaiting',
      label: '后台验收',
      task: (signal) => new Promise((_, reject) => {
        if (signal.aborted) {
          reject(new DOMException('Aborted', 'AbortError'))
          return
        }
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
          once: true,
        })
      }),
    })
    store.setter(runAtom, { runId: 'run-awaiting', status: 'awaiting_tool' })

    commands.stopRun()
    await execution.join(id, handle.executionId)

    expect(store.getter(runAtom)).toEqual({
      runId: 'run-awaiting',
      status: 'stopped',
      pendingExecutionId: undefined,
    })
    expect(store.getter(executionGraphAtom).nodes[handle.executionId]?.status).toBe('cancelled')
  })

  it('stopRun：无 active → no-op', () => {
    stopRun()
    expect(abortRun).not.toHaveBeenCalled()
  })

  it('withdrawCurrentTurnToDraft：stopped 后撤回当前未完成轮，用户输入回填草稿并剪掉本轮临时 UI', () => {
    const id = newSession()
    const store = getSessionStore(id).store
    store.setter(itemsAtom, [
      { id: 'u0', createdAt: 1, item: { role: 'user', content: '上一轮' } },
      { id: 'a0', createdAt: 2, item: { role: 'assistant', content: '上一轮回答' } },
      { id: 'u1', createdAt: 10, item: { role: 'user', content: '当前输入' } },
      { id: 'a1', createdAt: 11, item: { role: 'assistant', content: '半截回答' } },
    ])
    store.setter(runAtom, { runId: 'r', status: 'stopped' })
    store.setter(browserCardsAtom, [
      { id: 'old-card', createdAt: 3, title: '旧卡' },
      { id: 'new-card', createdAt: 11, title: '新卡' },
    ])
    store.setter(runtimeTranscriptEventsAtom, [
      { id: 'old-event', createdAt: 3, kind: 'system_injection', title: '旧注入' },
      { id: 'new-event', createdAt: 10, kind: 'tool_manifest', title: '新注入' },
    ])

    withdrawCurrentTurnToDraft()

    expect(abortRun).toHaveBeenCalledWith(id)
    expect(store.getter(itemsAtom).map((it) => it.id)).toEqual(['u0', 'a0'])
    expect(store.getter(runAtom)).toBeUndefined()
    expect(store.getter(composerDraftAtom)).toBe('当前输入')
    expect(store.getter(browserCardsAtom).map((card) => card.id)).toEqual(['old-card'])
    expect(store.getter(runtimeTranscriptEventsAtom).map((event) => event.id)).toEqual(['old-event'])
    expect(store.getter(withdrawnTurnNoticeAtom)).toMatchObject({
      text: '已撤回本轮对话并放回输入框。',
      sideEffects: false,
    })
  })

  it('withdrawCurrentTurnToDraft：本轮出现执行类工具时提示外部副作用不会自动撤销', () => {
    const id = newSession()
    const store = getSessionStore(id).store
    store.setter(itemsAtom, [
      { id: 'u1', createdAt: 10, item: { role: 'user', content: '跑一下 pwd' } },
      {
        id: 'a1',
        createdAt: 11,
        item: {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'tc1', type: 'function', function: { name: 'shell_macos', arguments: '{"command":"pwd"}' } },
          ],
        },
      },
      { id: 't1', createdAt: 12, item: { role: 'tool', tool_call_id: 'tc1', content: '{"stdout":"/tmp"}' } },
    ])
    store.setter(runAtom, { runId: 'r', status: 'stopped' })

    withdrawCurrentTurnToDraft()

    expect(store.getter(itemsAtom)).toEqual([])
    expect(store.getter(composerDraftAtom)).toBe('跑一下 pwd')
    expect(store.getter(withdrawnTurnNoticeAtom)).toMatchObject({ sideEffects: true })
    expect(store.getter(withdrawnTurnNoticeAtom)?.text).toContain('外部副作用')
  })

  it('withdrawCurrentTurnToDraft：stopped checkpoint 走标准回退并同步截断持久化历史', () => {
    const id = newSession()
    const store = getSessionStore(id).store
    const items: ConversationItem[] = [
      { id: 'u0', createdAt: 1, item: { role: 'user', content: '上一轮' } },
      { id: 'a0', createdAt: 2, item: { role: 'assistant', content: '上一轮回答' } },
      { id: 'u1', createdAt: 10, item: { role: 'user', content: '当前输入' } },
      { id: 'a1', createdAt: 11, item: { role: 'assistant', content: '半截回答' } },
    ]
    store.setter(itemsAtom, items)
    store.setter(checkpointsAtom, [
      { turnIndex: 0, label: '上一轮', createdAt: 2, items: items.slice(0, 2) },
      { turnIndex: 1, label: '[已停止] 当前输入', createdAt: 11, items },
    ])
    store.setter(runAtom, { runId: 'r', status: 'stopped' })

    withdrawCurrentTurnToDraft()

    expect(rewindBeforeCheckpoint).toHaveBeenCalledWith(id, 1, defaultCore)
    expect(store.getter(runAtom)).toBeUndefined()
    expect(store.getter(composerDraftAtom)).toBe('当前输入')
    expect(persistTruncate).toHaveBeenCalledWith(id, 0)
  })

  it('withdrawCurrentTurnToDraft：非 stopped 状态 no-op', () => {
    const id = newSession()
    const store = getSessionStore(id).store
    const items: ConversationItem[] = [{ id: 'u1', createdAt: 1, item: { role: 'user', content: 'hi' } }]
    store.setter(itemsAtom, items)
    store.setter(runAtom, { runId: 'r', status: 'running' })

    withdrawCurrentTurnToDraft()

    expect(store.getter(itemsAtom)).toBe(items)
    expect(store.getter(composerDraftAtom)).toBe('')
    expect(abortRun).not.toHaveBeenCalledWith(id)
  })
})
