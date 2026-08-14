// P-R3 命令 API 的单测（红→绿）。T3 从 commands.test.ts 拆出：轮次回退 / 计划阶段回退。
// ---------------------------------------------------------------------------
// 契约 U1/U2：commands 是 UI ↔ runtime 的唯一边界，且不收 store。
// 本测只断言「编排」：命令是否按约定调用了 jumpToCheckpoint/rewindBeforeCheckpoint/
// revertToPlanStageCheckpoint/updateCheckpoint/abortRun，以及是否正确读写 sessionStore。
// 真实 model / abort / checkpoint 全部 mock 掉。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// —— mock runtime 依赖：只验证编排，不跑真实 model / abort / checkpoint。——
vi.mock('./modelRun', () => ({
  runSession: vi.fn(() => Promise.resolve()),
  persistCurrentRunRecovery: vi.fn(),
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
import { defaultCore } from './core/coreInstance'
import { createDefaultPlanRuntime } from '@web-agent/tools-planning'

// C2 后 defaultCore 不再内置 plan runtime（实现在 tools-planning）；本套件的 rollbackPlanStage
// 用例需要真实语义，按 main.tsx 的装配方式在本文件 worker 内注入（isolate:true，不外溢）。
defaultCore.planRuntime = createDefaultPlanRuntime
import {
  jumpToCheckpoint,
  revertToPlanStageCheckpoint,
  rewindBeforeCheckpoint,
  updateCheckpoint,
} from '../state/checkpointWriters'
import { persistTruncate } from './persistenceBridge'
import { newSession, revertToTurn, revertTurnToDraft, rollbackPlanStage } from './commands'
import { spyOnDefaultAbort, type AbortSpies } from './commands.testHarness'

let abortRun: AbortSpies['abortRun']

beforeEach(() => {
  ;({ abortRun } = spyOnDefaultAbort())
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('commands（P-R3 UI 唯一入口 · 不收 store）', () => {
  // 种 n 个 checkpoint 到当前会话 store，让 turnIndex 落在合法区间（否则 revertToTurn 整体 no-op）。
  function seedCheckpoints(id: string, n: number): void {
    getSessionStore(id).store.setter(
      checkpointsAtom,
      Array.from({ length: n }, (_, i) => ({ turnIndex: i, label: `t${i}`, createdAt: i, items: [] })),
    )
  }

  it('revertToTurn：对当前 active 会话 jumpToCheckpoint', () => {
    const id = newSession()
    seedCheckpoints(id, 3) // index 2 合法
    revertToTurn(2)
    expect(jumpToCheckpoint).toHaveBeenCalledWith(id, 2, defaultCore)
  })

  it('revertToTurn：回退前先 abort 该会话正在跑的 run（避免迟到写回污染回退后状态）', () => {
    const id = newSession()
    seedCheckpoints(id, 3)
    revertToTurn(2)
    expect(abortRun).toHaveBeenCalledWith(id)
  })

  it('revertToTurn：回退后截断持久化 checkpoint（D-4）', () => {
    const id = newSession()
    seedCheckpoints(id, 3)
    revertToTurn(2)
    expect(persistTruncate).toHaveBeenCalledWith(id, 2)
  })

  it('revertToTurn：剪掉被丢弃轮次的 browser 卡片和 runtime transcript 事件（codex P2）', () => {
    const id = newSession()
    seedCheckpoints(id, 3) // checkpoint[k].createdAt === k
    const store = getSessionStore(id).store
    // 卡片和 transcript event 的 createdAt 分别落在回退点前后。
    store.setter(browserCardsAtom, [])
    store.setter(runtimeTranscriptEventsAtom, [])
    addBrowserCard(id, { id: 'c0', createdAt: 0, title: '轮0' })
    addBrowserCard(id, { id: 'c1', createdAt: 1, title: '轮1' })
    addBrowserCard(id, { id: 'c2', createdAt: 2, title: '轮2（将被丢弃）' })
    addRuntimeTranscriptEvent(id, { id: 'e0', createdAt: 0, kind: 'system_injection', title: '轮0' })
    addRuntimeTranscriptEvent(id, { id: 'e1', createdAt: 1, kind: 'tool_manifest', title: '轮1' })
    addRuntimeTranscriptEvent(id, { id: 'e2', createdAt: 2, kind: 'tool_manifest', title: '轮2（将被丢弃）' })
    revertToTurn(1) // 回退到 checkpoint[1]（createdAt=1）
    expect(store.getter(browserCardsAtom).map((c) => c.id)).toEqual(['c0', 'c1']) // createdAt>1 的 c2 被剪
    expect(store.getter(runtimeTranscriptEventsAtom).map((e) => e.id)).toEqual(['e0', 'e1'])
  })

  it('revertToTurn：越界/负数 turnIndex → 整体 no-op（不 abort、不 jump、不 persistTruncate）', () => {
    // 回归 codex P2：无效 index 时 jumpToCheckpoint 内存 no-op，但 persistTruncate(-1) 会误删全部盘上
    // checkpoint。修复后应在校验阶段整体 no-op —— 一个盘上写操作都不能发。
    const id = newSession()
    seedCheckpoints(id, 2) // 合法区间 [0,1]
    revertToTurn(-1)
    revertToTurn(2) // === length，越界
    revertToTurn(99)
    expect(jumpToCheckpoint).not.toHaveBeenCalled()
    expect(persistTruncate).not.toHaveBeenCalled()
    expect(abortRun).not.toHaveBeenCalled()
  })

  it('revertToTurn：无 active → no-op', () => {
    revertToTurn(2)
    expect(jumpToCheckpoint).not.toHaveBeenCalled()
  })

  function seedCompletedTurns(id: string): void {
    const firstTurn: ConversationItem[] = [
      { id: 'u0', createdAt: 10, item: { role: 'user', content: '第一问' } },
      { id: 'a0', createdAt: 11, item: { role: 'assistant', content: '第一答' } },
    ]
    const secondTurn: ConversationItem[] = [
      ...firstTurn,
      { id: 'u1', createdAt: 20, item: { role: 'user', content: '第二问' } },
      { id: 'a1', createdAt: 21, item: { role: 'assistant', content: '第二答' } },
    ]
    const store = getSessionStore(id).store
    store.setter(itemsAtom, secondTurn)
    store.setter(checkpointsAtom, [
      { turnIndex: 0, label: '第一问', createdAt: 11, items: firstTurn },
      { turnIndex: 1, label: '第二问', createdAt: 21, items: secondTurn },
    ])
    store.setter(runAtom, { runId: 'done', status: 'done' })
  }

  it('revertTurnToDraft：撤回目标轮本身并把用户输入放回草稿', () => {
    const id = newSession()
    seedCompletedTurns(id)
    const store = getSessionStore(id).store

    revertTurnToDraft(1)

    expect(abortRun).toHaveBeenCalledWith(id)
    expect(rewindBeforeCheckpoint).toHaveBeenCalledWith(id, 1, defaultCore)
    expect(store.getter(runAtom)).toBeUndefined()
    expect(store.getter(composerDraftAtom)).toBe('第二问')
    expect(store.getter(withdrawnTurnNoticeAtom)).toMatchObject({
      text: '已回退到该轮之前，原输入已放回输入框。',
      sideEffects: false,
    })
    expect(persistTruncate).toHaveBeenCalledWith(id, 0)
  })

  it('revertTurnToDraft：首轮回退会明确截断到 -1，避免恢复同一份 checkpoint 成为空操作', () => {
    const id = newSession()
    seedCompletedTurns(id)

    revertTurnToDraft(0)

    expect(rewindBeforeCheckpoint).toHaveBeenCalledWith(id, 0, defaultCore)
    expect(getSessionStore(id).store.getter(composerDraftAtom)).toBe('第一问')
    expect(persistTruncate).toHaveBeenCalledWith(id, -1)
  })

  // 阶段级回退：checkpoint 按用户消息分轮，而计划的几十次阶段推进通常都在同一轮内，
  // 轮级回退够不着计划内部。rollbackPlanStage 优先走阶段回退点（快照 + 截断对话），
  // 没有回退点的旧会话降级成前向重置（只清空阶段状态，不动对话）。
  function seedPlanStage(id: string, status: 'in_progress' | 'completed' = 'completed'): void {
    setPlan(id, {
      id: 'plan-rollback', title: '计划', objective: 'o', status: 'active', revision: 4,
      requiresApproval: false, createdAt: 1, updatedAt: 2,
      stages: [{
        id: 'build', title: '实现', objective: 'o', deliverables: [],
        dependencies: [], status, evidence: [],
      }],
    })
  }

  it('rollbackPlanStage：命中回退点时停 run、恢复快照并同步落盘当轮 checkpoint', async () => {
    const id = newSession()
    const store = getSessionStore(id).store
    seedPlanStage(id)
    store.setter(runAtom, { runId: 'r1', status: 'running' })
    store.setter(checkpointsAtom, [
      {
        turnIndex: 0,
        label: '[执行中] 轮1',
        createdAt: 5,
        items: [],
        recovery: { run: { runId: 'r1', status: 'awaiting_tool' } },
      },
    ])
    vi.mocked(revertToPlanStageCheckpoint).mockReturnValue({
      stageId: 'build',
      plan: { id: 'plan-rollback' } as never,
      itemCount: 0,
      createdAt: 7,
    })

    await rollbackPlanStage('plan-rollback', getPlan(id)!.revision, 'build')

    expect(abortRun).toHaveBeenCalledWith(id)
    expect(revertToPlanStageCheckpoint).toHaveBeenCalledWith(id, 'build', defaultCore)
    expect(store.getter(runAtom)).toBeUndefined()
    // 内存回退了、当轮 checkpoint 不同步的话，刷新就把被丢弃的阶段执行复活了。
    // 第 5 参 undefined = 清掉旧 run 的 recovery，避免刷新后被 hydrate 复活成可「继续执行」的 interrupted run。
    expect(updateCheckpoint).toHaveBeenCalledWith(id, 0, '[执行中] 轮1', defaultCore, undefined)
    expect(store.getter(withdrawnTurnNoticeAtom)?.text).toContain('已回退到该阶段开始前')
  })

  it('rollbackPlanStage：没有回退点的旧会话降级成前向重置，不动对话', async () => {
    const id = newSession()
    const store = getSessionStore(id).store
    seedPlanStage(id)
    const items: ConversationItem[] = [{ id: 'u1', createdAt: 1, item: { role: 'user', content: 'hi' } }]
    store.setter(itemsAtom, items)
    vi.mocked(revertToPlanStageCheckpoint).mockReturnValue(undefined)

    await rollbackPlanStage('plan-rollback', getPlan(id)!.revision, 'build')

    expect(store.getter(itemsAtom)).toBe(items)
    // 前向重置：阶段被重新打开，计划 revision 前进。
    expect(getPlan(id)?.stages[0].status).toBe('in_progress')
    expect(getPlan(id)?.revision).toBe(5)
    expect(store.getter(withdrawnTurnNoticeAtom)).toBeUndefined()
  })

  it('rollbackPlanStage：revision 不匹配（并发推进）→ 整体 no-op', async () => {
    const id = newSession()
    seedPlanStage(id)

    await rollbackPlanStage('plan-rollback', 999, 'build')

    expect(revertToPlanStageCheckpoint).not.toHaveBeenCalled()
    expect(abortRun).not.toHaveBeenCalledWith(id)
  })

  it('rollbackPlanStage：尚未开始的阶段 → 整体 no-op', async () => {
    const id = newSession()
    setPlan(id, {
      id: 'plan-rollback', title: '计划', objective: 'o', status: 'active', revision: 4,
      requiresApproval: false, createdAt: 1, updatedAt: 2,
      stages: [{
        id: 'build', title: '实现', objective: 'o', deliverables: [],
        dependencies: [], status: 'pending', evidence: [],
      }],
    })

    await rollbackPlanStage('plan-rollback', getPlan(id)!.revision, 'build')

    expect(revertToPlanStageCheckpoint).not.toHaveBeenCalled()
  })

  it('revertTurnToDraft：无效轮次整体 no-op', () => {
    const id = newSession()
    seedCompletedTurns(id)

    revertTurnToDraft(-1)
    revertTurnToDraft(2)

    expect(rewindBeforeCheckpoint).not.toHaveBeenCalled()
    expect(abortRun).not.toHaveBeenCalledWith(id)
    expect(persistTruncate).not.toHaveBeenCalled()
  })
})
