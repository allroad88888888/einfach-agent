// P-R3 命令 API 的单测（红→绿）。T3 从 commands.test.ts 拆出：ask_user / 计划审批的暂停恢复。
// ---------------------------------------------------------------------------
// 契约 U1/U2：commands 是 UI ↔ runtime 的唯一边界，且不收 store。
// 本测只断言「编排」：命令是否按约定调用了 beginRun/runToolLoop/endRun，以及是否正确
// 回填 ToolItem、清 pending 状态。真实 model / abort / checkpoint 全部 mock 掉。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// —— mock runtime 依赖：只验证编排，不跑真实 model / abort / checkpoint。——
// runToolLoop 也 mock（resumeWithAnswers 复用它续跑，只断言被调用、不真跑 model）。
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
import { itemsAtom, runAtom } from '../state/sessionAtoms'
import { getPendingQuestionAnswers, setPendingQuestionAnswer } from '../state/transientAtoms'
import type { ConversationItem, RunState } from '../state/core.type'
import { setPlan, getPlan } from '../state/planWriters'
import { runToolLoop } from './modelRun'
import { defaultCore } from './core/coreInstance'
import { createDefaultPlanRuntime } from '@web-agent/tools-planning'

// C2 后 defaultCore 不再内置 plan runtime（实现在 tools-planning）；approvePlan 用例需要真实语义，
// 按 main.tsx 的装配方式在本文件 worker 内注入（isolate:true，不外溢）。
defaultCore.planRuntime = createDefaultPlanRuntime
import { configureCommands, newSession, resumeWithAnswers, approvePlan } from './commands'
import { flush, spyOnDefaultAbort, type AbortSpies } from './commands.testHarness'

let beginRun: AbortSpies['beginRun']
let endRun: AbortSpies['endRun']

beforeEach(() => {
  ;({ beginRun, endRun } = spyOnDefaultAbort())
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('resumeWithAnswers（T-7 ask_user 暂停恢复）', () => {
  // 造一条 assistant(tool_calls:[ask_user{id}]) 条目。
  function askAssistant(tcId: string): ConversationItem {
    return {
      id: 'a1',
      createdAt: 2,
      item: {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: tcId, type: 'function', function: { name: 'ask_user_question', arguments: '{}' } },
        ],
      },
    }
  }

  // 种一个 waiting_user 会话：user + assistant(ask_user tc1)、run waiting_user + pendingQuestion、
  // pendingQuestionAnswers 有答案。返回 id（newSession 已设为 active）。
  function seedWaiting(tcId = 'tc1'): string {
    configureCommands({ modelCredentials: { deepseek: 'k' } })
    const id = newSession() // deepseek 默认 + 设为 active
    const store = getSessionStore(id).store
    store.setter(itemsAtom, [
      { id: 'u1', createdAt: 1, item: { role: 'user', content: 'hi' } },
      askAssistant(tcId),
    ])
    const run: RunState = { runId: 'R1', status: 'waiting_user', pendingQuestion: { questions: [{ id: 'q' }] } }
    store.setter(runAtom, run)
    setPendingQuestionAnswer(id, 'q', 'ans')
    vi.clearAllMocks() // 清掉 seed 期间 newSession 触发的 mock 调用记录
    return id
  }

  it('回填 ask_user 的 ToolItem（tool_call_id=tc1）+ 清答案 + patchRun running + runToolLoop 续跑', async () => {
    const id = seedWaiting('tc1')
    const store = getSessionStore(id).store

    resumeWithAnswers()
    await flush()

    // 回填了 tool_call_id==='tc1' 的 ToolItem，content 里带 answers。
    const items = store.getter(itemsAtom)
    const last = items[items.length - 1].item
    expect(last.role).toBe('tool')
    if (last.role !== 'tool') throw new Error('意外的条目形状')
    expect(last.tool_call_id).toBe('tc1')
    expect(JSON.parse(last.content)).toEqual({ answers: { q: 'ans' } })

    // 答案已清空。
    expect(getPendingQuestionAnswers(id)).toEqual({})

    // run 落回 running、pendingQuestion 清掉。
    const run = store.getter(runAtom)
    expect(run?.status).toBe('running')
    expect(run?.pendingQuestion).toBeUndefined()

    // 复用 pending run 的 runId 走 runToolLoop 续跑（apiKey 按 vendor 取）。
    expect(beginRun).toHaveBeenCalledWith(id)
    expect(runToolLoop).toHaveBeenCalledTimes(1)
    const call = vi.mocked(runToolLoop).mock.calls[0]
    expect(call[0]).toBe(id)
    expect(call[1]).toBe('R1')
    expect(call[2].apiKey).toBe('k')
    expect(call[2]).not.toHaveProperty('resumeToolCall')

    await flush()
    expect(endRun).toHaveBeenCalledWith(id, expect.anything())
  })

  it('优先按 pending decision 的 callId 回填，并保留 plan stage 归属', () => {
    const id = seedWaiting('older-call')
    const store = getSessionStore(id).store
    const payload = { questions: [{ id: 'q', text: '选择？', type: 'text' }] }
    store.setter(itemsAtom, [
      ...store.getter(itemsAtom),
      askAssistant('current-call'),
    ])
    store.setter(runAtom, {
      runId: 'R1',
      status: 'waiting_user',
      pendingQuestion: payload,
      pendingUserDecision: {
        callId: 'current-call',
        payload,
        origin: {
          surface: 'plan', phase: 'executing', planId: 'p1', planRevision: 2, stageId: 'build',
        },
      },
    })

    resumeWithAnswers()

    const answer = store.getter(itemsAtom).at(-1)
    expect(answer?.item).toMatchObject({ role: 'tool', tool_call_id: 'current-call' })
    expect(answer?.planStageId).toBe('build')
    expect(store.getter(runAtom)?.pendingUserDecision).toBeUndefined()
  })

  it('非 waiting_user（running）→ no-op（不回填、不续跑）', () => {
    const id = seedWaiting('tc1')
    const store = getSessionStore(id).store
    store.setter(runAtom, { runId: 'R1', status: 'running' })
    const before = store.getter(itemsAtom).length

    resumeWithAnswers()

    expect(store.getter(itemsAtom)).toHaveLength(before)
    expect(runToolLoop).not.toHaveBeenCalled()
    // 答案未被清（没进入恢复流程）。
    expect(getPendingQuestionAnswers(id)).toEqual({ q: 'ans' })
  })

  it('找不到 ask_user tool_call（最后 assistant 无 ask_user）→ 容错落回 running、不续跑', () => {
    const id = seedWaiting('tc1')
    const store = getSessionStore(id).store
    // 覆写：最后一条 assistant 不含 ask_user tool_call。
    store.setter(itemsAtom, [
      { id: 'u1', createdAt: 1, item: { role: 'user', content: 'hi' } },
      { id: 'a1', createdAt: 2, item: { role: 'assistant', content: '普通回复' } },
    ])

    resumeWithAnswers()

    const run = store.getter(runAtom)
    expect(run?.status).toBe('running')
    expect(run?.pendingQuestion).toBeUndefined()
    // 容错：不回填 ToolItem、不续跑。
    expect(store.getter(itemsAtom).some((it) => it.item.role === 'tool')).toBe(false)
    expect(runToolLoop).not.toHaveBeenCalled()
  })

  it('无 active → no-op', () => {
    resumeWithAnswers()
    expect(runToolLoop).not.toHaveBeenCalled()
  })
})

describe('approvePlan（计划审批暂停恢复）', () => {
  it('批准后回填结果、清 pendingPlanApproval，并沿用原 run 续跑', async () => {
    configureCommands({ modelCredentials: { deepseek: 'k' } })
    const id = newSession()
    const store = getSessionStore(id).store
    setPlan(id, {
      id: 'plan-approval', title: '审批计划', objective: '完成工作', status: 'awaiting_approval', revision: 3,
      requiresApproval: true, createdAt: 1, updatedAt: 2,
      stages: [{
        id: 'implement', title: '实现', objective: '完成代码', deliverables: [],
        dependencies: [], status: 'pending', evidence: [],
      }],
    })
    store.setter(runAtom, {
      runId: 'R-plan',
      status: 'waiting_plan_approval',
      pendingPlanApproval: { callId: 'plan-call', planId: 'plan-approval', revision: 3 },
    })
    vi.clearAllMocks()

    await approvePlan(true)

    const last = store.getter(itemsAtom).at(-1)?.item
    expect(last).toMatchObject({ role: 'tool', tool_call_id: 'plan-call' })
    if (last?.role !== 'tool') throw new Error('意外的条目形状')
    expect(JSON.parse(last.content)).toMatchObject({
      approved: true,
      plan: { id: 'plan-approval', status: 'approved' },
    })
    expect(getPlan(id)?.status).toBe('approved')
    expect(store.getter(runAtom)).toMatchObject({ status: 'running' })
    expect(store.getter(runAtom)?.pendingPlanApproval).toBeUndefined()

    expect(beginRun).toHaveBeenCalledWith(id)
    expect(runToolLoop).toHaveBeenCalledOnce()
    const call = vi.mocked(runToolLoop).mock.calls[0]
    expect(call[0]).toBe(id)
    expect(call[1]).toBe('R-plan')
    expect(call[2]).toMatchObject({ apiKey: 'k' })
    expect(call[2]).not.toHaveProperty('resumeToolCall')

    await flush()
    expect(endRun).toHaveBeenCalledWith(id, expect.anything())
  })
})
