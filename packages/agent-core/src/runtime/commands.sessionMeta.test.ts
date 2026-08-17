// P-R3 命令 API 的单测（红→绿）。T3 从 commands.test.ts 拆出：会话元数据类命令
// （卡片交互 / workspace 根目录 / 审批模式 / 标题派生与改名 / sendMessage 自动标题）。
// ---------------------------------------------------------------------------
// 契约 U1/U2：commands 是 UI ↔ runtime 的唯一边界，且不收 store。

import { afterEach, describe, expect, it, vi } from 'vitest'

// —— mock runtime 依赖：只验证编排，不跑真实 model / abort / checkpoint。——
vi.mock('./modelRun', () => ({
  runSession: vi.fn(() => Promise.resolve()),
  resumeInterruptedSession: vi.fn(() => Promise.resolve()),
  resumePlanSession: vi.fn(() => Promise.resolve()),
  runToolLoop: vi.fn(() => Promise.resolve()),
}))
vi.mock('../state/checkpointWriters', () => ({
  jumpToCheckpoint: vi.fn(),
  revertToPlanStageCheckpoint: vi.fn(),
  updateCheckpoint: vi.fn(),
}))
// D-4：持久化桥全 mock —— 只验证 commands 按约定调用了落盘钩子（不跑真实 IndexedDB）。
vi.mock('./persistenceBridge', () => ({
  persistSessions: vi.fn(),
  persistWorkspaces: vi.fn(),
  persistDeleteSession: vi.fn(),
}))

import { rootStore, workspacesAtom, activeWorkspaceIdAtom, sessionsAtom, activeSessionIdAtom } from '../state/rootStore'
import { runAtom } from '../state/sessionAtoms'
import { getSessionStore } from '../state/sessionStore'
import { getPendingQuestionAnswers, addPendingArtifact, pendingArtifactsAtom } from '../state/transientAtoms'
import { runSession } from './modelRun'
import { persistSessions, persistWorkspaces } from './persistenceBridge'
import {
  newSession,
  answerQuestion,
  discardArtifact,
  setWorkspaceRoot,
  setApprovalMode,
  configureCommands,
  sendMessage,
  DEFAULT_SESSION_TITLE,
  deriveSessionTitle,
  renameSession,
} from './commands'

afterEach(() => {
  vi.clearAllMocks()
})

describe('answerQuestion / discardArtifact（P8-c 卡片交互命令）', () => {
  it('answerQuestion：写进当前 active 会话的 pendingQuestionAnswers', () => {
    const id = newSession() // newSession 已设为 active
    const pendingQuestion = {
      id: 'ask-q',
      questions: [{ id: 'q', text: 'Continue?', type: 'text' as const }],
    }
    getSessionStore(id).store.setter(runAtom, {
      runId: 'waiting-run',
      status: 'waiting_user',
      pendingQuestion,
      pendingUserDecision: {
        callId: 'ask-q',
        payload: pendingQuestion,
        origin: { surface: 'conversation' },
      },
    })

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
  it('写进当前一级工作区（trim）+ 落盘，同工作区会话共享', () => {
    const id = newSession() // 自动创建并激活默认工作区
    const workspaceId = rootStore.getter(sessionsAtom)[id].workspaceId!
    vi.mocked(persistWorkspaces).mockClear()

    setWorkspaceRoot('  /Users/me/proj  ')

    const workspace = rootStore.getter(workspacesAtom)[workspaceId]
    expect(workspace.rootPath).toBe('/Users/me/proj')
    expect(workspace.name).toBe('proj')
    expect(persistWorkspaces).toHaveBeenCalled()
  })

  it('空/纯空白 → 清成 undefined（桥不传 → Rust 走 git root 兜底）', () => {
    const id = newSession()
    const workspaceId = rootStore.getter(sessionsAtom)[id].workspaceId!
    setWorkspaceRoot('/tmp/x')
    expect(rootStore.getter(workspacesAtom)[workspaceId].rootPath).toBe('/tmp/x')

    setWorkspaceRoot('   ')
    expect(rootStore.getter(workspacesAtom)[workspaceId].rootPath).toBeUndefined()
  })

  it('无 active 工作区 → no-op、不落盘', () => {
    rootStore.setter(activeWorkspaceIdAtom, '')
    vi.mocked(persistWorkspaces).mockClear()
    expect(() => setWorkspaceRoot('/x')).not.toThrow()
    expect(persistWorkspaces).not.toHaveBeenCalled()
  })
})

describe('setApprovalMode', () => {
  it('按会话保存模式并持久化', () => {
    const id = newSession()
    vi.mocked(persistSessions).mockClear()

    setApprovalMode('auto')

    expect(rootStore.getter(sessionsAtom)[id].toolApprovalMode).toBe('auto')
    expect(persistSessions).toHaveBeenCalled()
  })

  it('旧会话缺省视为 confirm，同值写入不产生持久化', () => {
    newSession()
    vi.mocked(persistSessions).mockClear()

    setApprovalMode('confirm')

    expect(persistSessions).not.toHaveBeenCalled()
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
  it('标题仍为默认值 → 用本条输入派生标题（run 照常启动）', async () => {
    configureCommands({ modelCredentials: { deepseek: 'k' } })
    const id = newSession()
    expect(rootStore.getter(sessionsAtom)[id].title).toBe(DEFAULT_SESSION_TITLE)

    await sendMessage('  帮我   查天气  ')

    expect(rootStore.getter(sessionsAtom)[id].title).toBe('帮我 查天气')
    expect(runSession).toHaveBeenCalledTimes(1)
  })

  it('用户已改名（≠默认）→ 绝不覆盖', () => {
    configureCommands({ modelCredentials: { deepseek: 'k' } })
    const id = newSession({ title: '我的会话' })

    sendMessage('hello world')

    expect(rootStore.getter(sessionsAtom)[id].title).toBe('我的会话')
  })

  it('第二条消息不再改（首条已把标题改成非默认）', async () => {
    configureCommands({ modelCredentials: { deepseek: 'k' } })
    const id = newSession()

    await sendMessage('第一条消息')
    expect(rootStore.getter(sessionsAtom)[id].title).toBe('第一条消息')

    await sendMessage('第二条完全不同的消息')
    expect(rootStore.getter(sessionsAtom)[id].title).toBe('第一条消息')
  })
})
