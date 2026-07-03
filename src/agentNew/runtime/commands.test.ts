// P-R3 命令 API 的单测（红→绿）。
// ---------------------------------------------------------------------------
// 契约 U1/U2：commands 是 UI ↔ runtime 的唯一边界，且不收 store。
// 本测只断言「编排」：命令是否按约定调用了 beginRun/runSession/endRun/abortRun/
// jumpToCheckpoint，以及是否正确读写 rootStore（sessionsAtom/activeSessionIdAtom）
// 和 sessionStore（getSessionStore）。真实 model / abort / checkpoint 全部 mock 掉。

import { afterEach, describe, expect, it, vi } from 'vitest'

// —— mock runtime 依赖：只验证编排，不跑真实 model / abort / checkpoint。——
// runToolLoop 也 mock（resumeWithAnswers 复用它续跑，只断言被调用、不真跑 model）。
vi.mock('./modelRun', () => ({
  runSession: vi.fn(() => Promise.resolve()),
  runToolLoop: vi.fn(() => Promise.resolve()),
}))
vi.mock('./abortRegistry', () => ({
  beginRun: vi.fn(() => new AbortController().signal),
  abortRun: vi.fn(),
  endRun: vi.fn(),
}))
vi.mock('../state/checkpointWriters', () => ({ jumpToCheckpoint: vi.fn() }))
// D-4：持久化桥全 mock —— 只验证 commands 按约定调用了落盘钩子（不跑真实 IndexedDB）。
vi.mock('./persistenceBridge', () => ({
  persistSessions: vi.fn(),
  persistDeleteSession: vi.fn(),
  persistTruncate: vi.fn(),
}))

import { rootStore, sessionsAtom, activeSessionIdAtom, resetRootStore } from '../state/rootStore'
import { getSessionStore, resetSessionStores } from '../state/sessionStore'
import { itemsAtom, runAtom, checkpointsAtom } from '../state/sessionAtoms'
import {
  getPendingQuestionAnswers,
  setPendingQuestionAnswer,
  addPendingArtifact,
  pendingArtifactsAtom,
  addBrowserCard,
  browserCardsAtom,
  alwaysAllowedToolsAtom,
} from '../state/transientAtoms'
import type { ConversationItem, RunState } from '../state/core.type'
import { runSession, runToolLoop } from './modelRun'
import { beginRun, abortRun, endRun } from './abortRegistry'
import { jumpToCheckpoint } from '../state/checkpointWriters'
import { persistSessions, persistDeleteSession, persistTruncate } from './persistenceBridge'
import {
  configureCommands,
  newSession,
  selectSession,
  removeSession,
  sendMessage,
  stopRun,
  revertToTurn,
  resumeWithAnswers,
  answerQuestion,
  discardArtifact,
  setWorkspaceRoot,
  confirmTool,
  DEFAULT_SESSION_TITLE,
  deriveSessionTitle,
  renameSession,
} from './commands'

afterEach(() => {
  resetRootStore()
  resetSessionStores()
  vi.clearAllMocks()
})

// 让挂在 Promise 上的 .finally 微任务跑完。
async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('commands（P-R3 UI 唯一入口 · 不收 store）', () => {
  it('newSession：登记 sessionsAtom + 设为 active + 建 session store', () => {
    const before = Object.keys(rootStore.getter(sessionsAtom)).length
    const id = newSession()

    const sessions = rootStore.getter(sessionsAtom)
    expect(Object.keys(sessions)).toHaveLength(before + 1)
    expect(sessions[id]).toBeTruthy()
    expect(sessions[id].settings.vendor).toBe('deepseek')
    expect(rootStore.getter(activeSessionIdAtom)).toBe(id)
    expect(getSessionStore(id)).toBeTruthy()
    // D-4：新建会话后落盘会话列表。
    expect(persistSessions).toHaveBeenCalled()
  })

  it('newSession：opts.title / opts.settings 覆盖默认', () => {
    const id = newSession({
      title: '我的会话',
      settings: { vendor: 'glm', model: 'glm-x' },
    })
    const meta = rootStore.getter(sessionsAtom)[id]
    expect(meta.title).toBe('我的会话')
    expect(meta.settings).toEqual({ vendor: 'glm', model: 'glm-x' })
  })

  it('selectSession：切 activeSessionIdAtom', () => {
    selectSession('x')
    expect(rootStore.getter(activeSessionIdAtom)).toBe('x')
  })

  it('removeSession：从 sessionsAtom 删除该 id', () => {
    const a = newSession()
    const b = newSession()
    removeSession(a)

    const sessions = rootStore.getter(sessionsAtom)
    expect(sessions[a]).toBeUndefined()
    expect(sessions[b]).toBeTruthy()
  })

  it('removeSession：删的是当前 active → active 落到剩余任一 id', () => {
    const a = newSession()
    const b = newSession() // b 现在是 active
    removeSession(b)
    // active 落到剩余的 a。
    expect(rootStore.getter(activeSessionIdAtom)).toBe(a)
  })

  it('removeSession：删最后一个 active → active 置空串', () => {
    const a = newSession()
    removeSession(a)
    expect(rootStore.getter(activeSessionIdAtom)).toBe('')
  })

  it('removeSession：先 abort 该会话正在跑的 run（避免 controller 泄漏）', () => {
    const a = newSession()
    removeSession(a)
    expect(abortRun).toHaveBeenCalledWith(a)
  })

  it('removeSession：落盘会话列表 + 清盘该会话历史（D-4）', () => {
    const a = newSession()
    vi.mocked(persistSessions).mockClear()
    removeSession(a)
    expect(persistSessions).toHaveBeenCalled()
    expect(persistDeleteSession).toHaveBeenCalledWith(a)
  })

  it('sendMessage：起 run（beginRun→runSession，apiKey 按 vendor 取）', async () => {
    configureCommands({ deepseekApiKey: 'k' })
    const id = newSession() // deepseek 默认

    sendMessage('hi')

    expect(beginRun).toHaveBeenCalledWith(id)
    expect(runSession).toHaveBeenCalledTimes(1)
    const call = vi.mocked(runSession).mock.calls[0]
    expect(call[0]).toBe(id)
    expect(call[1]).toBe('hi')
    expect(call[2].apiKey).toBe('k')

    await flush()
    expect(endRun).toHaveBeenCalledWith(id, expect.anything())
  })

  it('sendMessage：vendor=glm → 取 glmApiKey', () => {
    configureCommands({ deepseekApiKey: 'dk', glmApiKey: 'gk' })
    newSession({ settings: { vendor: 'glm', model: 'glm-x' } })

    sendMessage('hi')
    expect(vi.mocked(runSession).mock.calls[0][2].apiKey).toBe('gk')
  })

  it('sendMessage：空输入 → 不起 run', () => {
    newSession()
    sendMessage('   ')
    expect(runSession).not.toHaveBeenCalled()
    expect(beginRun).not.toHaveBeenCalled()
  })

  it('sendMessage：无 active 会话 → 不起 run', () => {
    sendMessage('hi')
    expect(runSession).not.toHaveBeenCalled()
  })

  it('sendMessage：当前 run 忙碌（running/awaiting_tool/waiting_user/waiting_confirmation）→ no-op（codex P2）', () => {
    // 忙碌时发新消息会顶掉未完成的 run；waiting_user/waiting_confirmation 时更会造成非法 tool-call 序列。命令层兜底。
    configureCommands({ deepseekApiKey: 'k' })
    const id = newSession()
    for (const status of ['running', 'awaiting_tool', 'waiting_user', 'waiting_confirmation'] as const) {
      getSessionStore(id).store.setter(runAtom, { runId: 'r', status })
      sendMessage('hi')
      expect(runSession).not.toHaveBeenCalled()
      expect(beginRun).not.toHaveBeenCalled()
    }
  })

  it('stopRun：中断当前 active 会话的 run', () => {
    const id = newSession()
    stopRun()
    expect(abortRun).toHaveBeenCalledWith(id)
  })

  it('stopRun：无 active → no-op', () => {
    stopRun()
    expect(abortRun).not.toHaveBeenCalled()
  })

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
    expect(jumpToCheckpoint).toHaveBeenCalledWith(id, 2)
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

  it('revertToTurn：剪掉被丢弃轮次的 browser 卡片（codex P2）', () => {
    const id = newSession()
    seedCheckpoints(id, 3) // checkpoint[k].createdAt === k
    const store = getSessionStore(id).store
    // 三张卡片，createdAt 分别落在回退点前后。
    store.setter(browserCardsAtom, [])
    addBrowserCard(id, { id: 'c0', createdAt: 0, title: '轮0' })
    addBrowserCard(id, { id: 'c1', createdAt: 1, title: '轮1' })
    addBrowserCard(id, { id: 'c2', createdAt: 2, title: '轮2（将被丢弃）' })
    revertToTurn(1) // 回退到 checkpoint[1]（createdAt=1）
    expect(store.getter(browserCardsAtom).map((c) => c.id)).toEqual(['c0', 'c1']) // createdAt>1 的 c2 被剪
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
    configureCommands({ deepseekApiKey: 'k' })
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

    await flush()
    expect(endRun).toHaveBeenCalledWith(id, expect.anything())
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

describe('answerQuestion / discardArtifact（P8-c 卡片交互命令）', () => {
  it('answerQuestion：写进当前 active 会话的 pendingQuestionAnswers', () => {
    const id = newSession() // newSession 已设为 active
    answerQuestion('q', 'v')
    expect(getPendingQuestionAnswers(id)).toEqual({ q: 'v' })
  })

  it('answerQuestion：无 active → no-op、不崩', () => {
    // afterEach 复位后 activeSessionIdAtom 为初始空串 —— 无 active。
    rootStore.setter(activeSessionIdAtom, '')
    expect(() => answerQuestion('q', 'v')).not.toThrow()
  })

  it('discardArtifact：删的是传入的 sessionId（不受 active 影响，PF4）', () => {
    const a = newSession() // a 现在是 active
    addPendingArtifact(a, { id: 'art1', filename: 'f1.txt', content: 'x' })
    addPendingArtifact(a, { id: 'art2', filename: 'f2.txt', content: 'y' })

    // 切走 active 到另一会话 b —— 模拟异步保存期间 active 被切走（PF4 场景）。
    const b = newSession()
    expect(rootStore.getter(activeSessionIdAtom)).toBe(b)

    // 显式传入归属会话 a，删 art1 —— 应删 a 里的、与当前 active(b) 无关。
    discardArtifact(a, 'art1')

    const artifactsA = getSessionStore(a).store.getter(pendingArtifactsAtom)
    expect(artifactsA.map((x) => x.id)).toEqual(['art2'])
  })
})

describe('setWorkspaceRoot（S4-A workspace 绑定）', () => {
  it('写进当前 active 会话的 SessionMeta.workspaceRoot（trim）+ 落盘', () => {
    const id = newSession() // 已 active
    vi.mocked(persistSessions).mockClear()

    setWorkspaceRoot('  /Users/me/proj  ')

    const meta = rootStore.getter(sessionsAtom)[id]
    expect(meta.workspaceRoot).toBe('/Users/me/proj')
    expect(persistSessions).toHaveBeenCalled()
  })

  it('空/纯空白 → 清成 undefined（桥不传 → Rust 走 git root 兜底）', () => {
    const id = newSession()
    setWorkspaceRoot('/tmp/x')
    expect(rootStore.getter(sessionsAtom)[id].workspaceRoot).toBe('/tmp/x')

    setWorkspaceRoot('   ')
    expect(rootStore.getter(sessionsAtom)[id].workspaceRoot).toBeUndefined()
  })

  it('无 active → no-op、不落盘', () => {
    rootStore.setter(activeSessionIdAtom, '')
    vi.mocked(persistSessions).mockClear()
    expect(() => setWorkspaceRoot('/x')).not.toThrow()
    expect(persistSessions).not.toHaveBeenCalled()
  })
})

describe('confirmTool（S4-B 危险工具确认恢复）', () => {
  // 造一条 assistant(tool_calls:[write_file{id}]) 条目（危险工具，暂停时 result 特意留空）。
  function dangerousAssistant(tcId: string): ConversationItem {
    return {
      id: 'a1',
      createdAt: 2,
      item: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: tcId, type: 'function', function: { name: 'write_file', arguments: '{}' } }],
      },
    }
  }

  // 种一个 waiting_confirmation 会话：user + assistant(write_file tc)、run waiting_confirmation +
  //   pendingToolConfirmation。返回 id（newSession 已设为 active）。
  function seedConfirming(tcId = 'w1'): string {
    configureCommands({ deepseekApiKey: 'k' })
    const id = newSession()
    const store = getSessionStore(id).store
    store.setter(itemsAtom, [
      { id: 'u1', createdAt: 1, item: { role: 'user', content: 'hi' } },
      dangerousAssistant(tcId),
    ])
    const run: RunState = {
      runId: 'R1',
      status: 'waiting_confirmation',
      pendingToolConfirmation: { callId: tcId, toolName: 'write_file', args: { path: 'a.txt', content: 'x' } },
    }
    store.setter(runAtom, run)
    vi.clearAllMocks() // 清掉 seed 期间 newSession 触发的 mock 调用记录
    return id
  }

  it('允许：落回 running + 清 pendingToolConfirmation + runToolLoop 带 resumeToolCall 续跑', async () => {
    const id = seedConfirming('w1')
    const store = getSessionStore(id).store

    confirmTool(true)

    const run = store.getter(runAtom)
    expect(run?.status).toBe('running')
    expect(run?.pendingToolConfirmation).toBeUndefined()

    expect(beginRun).toHaveBeenCalledWith(id)
    expect(runToolLoop).toHaveBeenCalledTimes(1)
    const call = vi.mocked(runToolLoop).mock.calls[0]
    expect(call[0]).toBe(id)
    expect(call[1]).toBe('R1')
    expect(call[2].resumeToolCall).toEqual({
      callId: 'w1',
      toolName: 'write_file',
      args: { path: 'a.txt', content: 'x' },
    })

    await flush()
    expect(endRun).toHaveBeenCalledWith(id, expect.anything())
  })

  it('允许 + always：把该工具记进本 session「一律允许」集合', () => {
    const id = seedConfirming('w1')
    confirmTool(true, true)
    expect(getSessionStore(id).store.getter(alwaysAllowedToolsAtom)).toContain('write_file')
  })

  it('拒绝：回填该 tool_call 的 error result + 落回 running + runToolLoop 续跑（不带 resumeToolCall）', () => {
    const id = seedConfirming('w1')
    const store = getSessionStore(id).store

    confirmTool(false)

    // 回填了 tool_call_id==='w1' 的 error ToolItem。
    const last = store.getter(itemsAtom).at(-1)!.item
    expect(last.role).toBe('tool')
    if (last.role !== 'tool') throw new Error('意外的条目形状')
    expect(last.tool_call_id).toBe('w1')
    expect(JSON.parse(last.content)).toEqual({ error: '用户拒绝执行该工具' })

    expect(store.getter(runAtom)?.status).toBe('running')
    expect(runToolLoop).toHaveBeenCalledTimes(1)
    // 拒绝不执行工具 → 不带 resumeToolCall。
    expect(vi.mocked(runToolLoop).mock.calls[0][2].resumeToolCall).toBeUndefined()
  })

  it('非 waiting_confirmation（running）→ no-op（不回填、不续跑）', () => {
    const id = seedConfirming('w1')
    const store = getSessionStore(id).store
    store.setter(runAtom, { runId: 'R1', status: 'running' })
    const before = store.getter(itemsAtom).length

    confirmTool(true)

    expect(store.getter(itemsAtom)).toHaveLength(before)
    expect(runToolLoop).not.toHaveBeenCalled()
  })

  it('缺 pendingToolConfirmation → 容错落回 running、不续跑', () => {
    const id = seedConfirming('w1')
    const store = getSessionStore(id).store
    store.setter(runAtom, { runId: 'R1', status: 'waiting_confirmation' })

    confirmTool(true)

    expect(store.getter(runAtom)?.status).toBe('running')
    expect(runToolLoop).not.toHaveBeenCalled()
  })

  it('无 active → no-op', () => {
    confirmTool(true)
    expect(runToolLoop).not.toHaveBeenCalled()
  })
})

describe('deriveSessionTitle（TT2 标题派生纯函数）', () => {
  it('压缩空白：连串空白（含换行/tab）折成单空格并去首尾', () => {
    expect(deriveSessionTitle('  帮我  查一下\n\t天气  ')).toBe('帮我 查一下 天气')
  })

  it('超过 12 字：按 code point 截前 12 字 + …', () => {
    expect(deriveSessionTitle('一二三四五六七八九十一二三')).toBe('一二三四五六七八九十一二…')
  })

  it('恰好 12 字：不截断、不加 …', () => {
    expect(deriveSessionTitle('一二三四五六七八九十一二')).toBe('一二三四五六七八九十一二')
  })

  it('emoji 按 code point 计数，截断不断裂（无残缺代理对）', () => {
    expect(deriveSessionTitle('🍎'.repeat(13))).toBe('🍎'.repeat(12) + '…')
  })

  it('全空白 → 空串（由调用方决定保留默认名）', () => {
    expect(deriveSessionTitle('   \n\t  ')).toBe('')
  })
})

describe('renameSession（TT3 会话改名命令）', () => {
  it('正常改名：trim + 不可变更新 + updatedAt 前进 + 落盘', () => {
    const id = newSession()
    // 把 updatedAt 拨回过去，验证 renameSession 会让它前进（同毫秒内 Date.now() 无法区分）。
    rootStore.setter(sessionsAtom, (prev) => ({ ...prev, [id]: { ...prev[id], updatedAt: 1 } }))
    vi.mocked(persistSessions).mockClear()

    renameSession(id, '  新名字  ')

    const meta = rootStore.getter(sessionsAtom)[id]
    expect(meta.title).toBe('新名字')
    expect(meta.updatedAt).toBeGreaterThan(1)
    expect(persistSessions).toHaveBeenCalled()
  })

  it('trim 后空 → no-op（保留原名、不落盘，编辑框取消语义）', () => {
    const id = newSession({ title: '原名' })
    vi.mocked(persistSessions).mockClear()

    renameSession(id, '   ')

    expect(rootStore.getter(sessionsAtom)[id].title).toBe('原名')
    expect(persistSessions).not.toHaveBeenCalled()
  })

  it('ghost 会话（未登记）→ no-op、不落盘', () => {
    vi.mocked(persistSessions).mockClear()
    expect(() => renameSession('ghost', '新名')).not.toThrow()
    expect(rootStore.getter(sessionsAtom)['ghost']).toBeUndefined()
    expect(persistSessions).not.toHaveBeenCalled()
  })

  it('超长标题按 code point 截 48 字（emoji 不断裂）', () => {
    const id = newSession()
    renameSession(id, '🍎'.repeat(50))
    expect(rootStore.getter(sessionsAtom)[id].title).toBe('🍎'.repeat(48))
  })
})

describe('sendMessage 自动标题（TT1）', () => {
  it('标题仍为默认值 → 用本条输入派生标题（run 照常启动）', () => {
    configureCommands({ deepseekApiKey: 'k' })
    const id = newSession()
    expect(rootStore.getter(sessionsAtom)[id].title).toBe(DEFAULT_SESSION_TITLE)

    sendMessage('  帮我   查天气  ')

    expect(rootStore.getter(sessionsAtom)[id].title).toBe('帮我 查天气')
    expect(runSession).toHaveBeenCalledTimes(1)
  })

  it('用户已改名（≠默认）→ 绝不覆盖', () => {
    configureCommands({ deepseekApiKey: 'k' })
    const id = newSession({ title: '我的会话' })

    sendMessage('hello world')

    expect(rootStore.getter(sessionsAtom)[id].title).toBe('我的会话')
  })

  it('第二条消息不再改（首条已把标题改成非默认）', () => {
    configureCommands({ deepseekApiKey: 'k' })
    const id = newSession()

    sendMessage('第一条消息')
    expect(rootStore.getter(sessionsAtom)[id].title).toBe('第一条消息')

    sendMessage('第二条完全不同的消息')
    expect(rootStore.getter(sessionsAtom)[id].title).toBe('第一条消息')
  })
})
