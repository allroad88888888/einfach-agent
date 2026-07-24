import { afterEach, describe, expect, it } from 'vitest'
import { createStore } from '@einfach/core'

import { rootStore, sessionsAtom, resetRootStore } from './rootStore'
import { getSessionStore, resetSessionStores } from './sessionStore'
import { createCoreInstance } from '../runtime/core/coreInstance'
import {
  pendingArtifactsAtom,
  browserCardsAtom,
  pendingQuestionAnswersAtom,
  alwaysAllowedToolsAtom,
  composerDraftAtom,
  queuedUserMessagesAtom,
  withdrawnTurnNoticeAtom,
  contextStatsAtom,
  addPendingArtifact,
  removePendingArtifact,
  addBrowserCard,
  pruneBrowserCardsAfter,
  setPendingQuestionAnswer,
  getPendingQuestionAnswers,
  clearPendingQuestionAnswers,
  addAlwaysAllowedTool,
  isToolAlwaysAllowed,
  setComposerDraft,
  enqueueUserMessage,
  takeQueuedUserMessages,
  setWithdrawnTurnNotice,
  setContextStats,
  type PendingArtifact,
  type BrowserCard,
  type ContextStatsSnapshot,
} from './transientAtoms'

// TK5 瞬态 atom —— 单测先行（C6）。这些 atom 是「会话 store 内共享单例 key」，
// 值随 store 隔离（不分桶）；写入器 ghost guard 查 rootStore.sessionsAtom 登记表。

afterEach(() => {
  resetRootStore()
  resetSessionStores()
})

// 在 rootStore 登记表里 seed 一个会话（否则 ghost guard 会拦掉写入）。
function seedSession(id = 's1'): void {
  rootStore.setter(sessionsAtom, {
    [id]: {
      id,
      title: 't',
      settings: { vendor: 'deepseek', model: 'x' },
      createdAt: 0,
      updatedAt: 0,
    },
  })
}

const sampleArtifact: PendingArtifact = {
  id: 'a1',
  filename: 'out.txt',
  content: 'hello',
  mimeType: 'text/plain',
}

const sampleCard: BrowserCard = {
  id: 'c1',
  createdAt: 1,
  title: 'card',
  body: 'body',
}

describe('transientAtoms —— 共享单例 key 值随 store 隔离（不分桶，C3）', () => {
  it('同一 pendingArtifactsAtom 在两个 store 里互相隔离', () => {
    const a = createStore()
    const b = createStore()

    a.setter(pendingArtifactsAtom, [sampleArtifact])

    expect(a.getter(pendingArtifactsAtom)).toHaveLength(1)
    expect(b.getter(pendingArtifactsAtom)).toEqual([])
  })

  it('同一 browserCardsAtom 在两个 store 里互相隔离', () => {
    const a = createStore()
    const b = createStore()

    a.setter(browserCardsAtom, [sampleCard])

    expect(a.getter(browserCardsAtom)).toHaveLength(1)
    expect(b.getter(browserCardsAtom)).toEqual([])
  })

  it('同一 pendingQuestionAnswersAtom 在两个 store 里互相隔离', () => {
    const a = createStore()
    const b = createStore()

    a.setter(pendingQuestionAnswersAtom, { q1: 'yes' })

    expect(a.getter(pendingQuestionAnswersAtom)).toEqual({ q1: 'yes' })
    expect(b.getter(pendingQuestionAnswersAtom)).toEqual({})
  })

  it('各 atom 默认值正确（新 store 未写入时）', () => {
    const b = createStore()

    expect(b.getter(pendingArtifactsAtom)).toEqual([])
    expect(b.getter(browserCardsAtom)).toEqual([])
    expect(b.getter(pendingQuestionAnswersAtom)).toEqual({})
    expect(b.getter(composerDraftAtom)).toBe('')
    expect(b.getter(queuedUserMessagesAtom)).toEqual([])
    expect(b.getter(withdrawnTurnNoticeAtom)).toBeUndefined()
    expect(b.getter(contextStatsAtom)).toBeUndefined()
  })
})

describe('queuedUserMessagesAtom', () => {
  it('按 FIFO 追加，并只取走指定 run 的消息', () => {
    seedSession()
    enqueueUserMessage('s1', { id: 'q1', createdAt: 1, content: '一', targetRunId: 'r1' })
    enqueueUserMessage('s1', { id: 'q2', createdAt: 2, content: '二', targetRunId: 'r2' })
    enqueueUserMessage('s1', { id: 'q3', createdAt: 3, content: '三', targetRunId: 'r1' })

    expect(takeQueuedUserMessages('s1', 'r1')).toEqual([
      { id: 'q1', createdAt: 1, content: '一', targetRunId: 'r1' },
      { id: 'q3', createdAt: 3, content: '三', targetRunId: 'r1' },
    ])
    expect(getSessionStore('s1').store.getter(queuedUserMessagesAtom)).toEqual([
      { id: 'q2', createdAt: 2, content: '二', targetRunId: 'r2' },
    ])
  })

  it('未登记会话不会生成 ghost queue', () => {
    enqueueUserMessage('ghost', { id: 'q1', createdAt: 1, content: '一', targetRunId: 'r1' })
    expect(takeQueuedUserMessages('ghost', 'r1')).toEqual([])
  })
})

describe('addPendingArtifact', () => {
  it('把 artifact 追加到该会话 store 的 pendingArtifactsAtom', () => {
    seedSession()
    addPendingArtifact('s1', sampleArtifact)
    expect(getSessionStore('s1').store.getter(pendingArtifactsAtom)).toContainEqual(
      sampleArtifact,
    )
  })

  it('产生新数组引用（不可变更新，C4）', () => {
    seedSession()
    const before = getSessionStore('s1').store.getter(pendingArtifactsAtom)
    addPendingArtifact('s1', sampleArtifact)
    const after = getSessionStore('s1').store.getter(pendingArtifactsAtom)
    expect(after).not.toBe(before)
    expect(after).toHaveLength(1)
  })

  it('未登记会话 → ghost guard no-op（C7）', () => {
    addPendingArtifact('sX', sampleArtifact)
    expect(getSessionStore('sX').store.getter(pendingArtifactsAtom)).toEqual([])
  })
})

describe('removePendingArtifact', () => {
  const otherArtifact: PendingArtifact = {
    id: 'a2',
    filename: 'other.txt',
    content: 'world',
    mimeType: 'text/plain',
  }

  it('删掉指定 artifactId 后剩下另一个（新数组引用，不可变 C4）', () => {
    seedSession()
    addPendingArtifact('s1', sampleArtifact)
    addPendingArtifact('s1', otherArtifact)
    const before = getSessionStore('s1').store.getter(pendingArtifactsAtom)
    removePendingArtifact('s1', sampleArtifact.id)
    const after = getSessionStore('s1').store.getter(pendingArtifactsAtom)
    expect(after).not.toBe(before)
    expect(after).toHaveLength(1)
    expect(after).toEqual([otherArtifact])
  })

  it('删不存在的 artifactId → 不崩，内容不变', () => {
    seedSession()
    addPendingArtifact('s1', sampleArtifact)
    removePendingArtifact('s1', 'nope')
    expect(getSessionStore('s1').store.getter(pendingArtifactsAtom)).toEqual([sampleArtifact])
  })

  it('未登记会话 → ghost guard no-op（不崩、不复活幽灵会话，C7）', () => {
    removePendingArtifact('sX', 'a1')
    expect(getSessionStore('sX').store.getter(pendingArtifactsAtom)).toEqual([])
    expect(rootStore.getter(sessionsAtom).sX).toBeUndefined()
  })
})

describe('addBrowserCard', () => {
  it('把 card 追加到该会话 store 的 browserCardsAtom', () => {
    seedSession()
    addBrowserCard('s1', sampleCard)
    expect(getSessionStore('s1').store.getter(browserCardsAtom)).toContainEqual(sampleCard)
  })

  it('产生新数组引用（不可变更新，C4）', () => {
    seedSession()
    const before = getSessionStore('s1').store.getter(browserCardsAtom)
    addBrowserCard('s1', sampleCard)
    const after = getSessionStore('s1').store.getter(browserCardsAtom)
    expect(after).not.toBe(before)
    expect(after).toHaveLength(1)
  })

  it('未登记会话 → ghost guard no-op（C7）', () => {
    addBrowserCard('sX', sampleCard)
    expect(getSessionStore('sX').store.getter(browserCardsAtom)).toEqual([])
  })
})

describe('pruneBrowserCardsAfter', () => {
  it('剪掉 createdAt 晚于回退点的卡片，保留 <= 的（含相等）', () => {
    seedSession()
    const store = getSessionStore('s1').store
    store.setter(browserCardsAtom, [
      { id: 'c1', createdAt: 10, title: 't1' },
      { id: 'c2', createdAt: 20, title: 't2' },
      { id: 'c3', createdAt: 30, title: 't3' },
    ])
    pruneBrowserCardsAfter('s1', 20)
    const kept = store.getter(browserCardsAtom)
    expect(kept.map((c) => c.id)).toEqual(['c1', 'c2']) // 20 保留（<=），30 剪掉
  })

  it('不可变：产生新数组引用', () => {
    seedSession()
    const store = getSessionStore('s1').store
    store.setter(browserCardsAtom, [{ id: 'c1', createdAt: 30, title: 't' }])
    const before = store.getter(browserCardsAtom)
    pruneBrowserCardsAfter('s1', 5) // 全剪
    const after = store.getter(browserCardsAtom)
    expect(after).toEqual([])
    expect(after).not.toBe(before)
  })

  it('未登记会话 → no-op（ghost guard，不复活幽灵会话）', () => {
    pruneBrowserCardsAfter('ghost', 0)
    expect(getSessionStore('ghost').store.getter(browserCardsAtom)).toEqual([])
  })
})

describe('pendingQuestionAnswers —— add → get → clear round-trip', () => {
  it('setPendingQuestionAnswer 后 getPendingQuestionAnswers 读到答案', () => {
    seedSession()
    setPendingQuestionAnswer('s1', 'q1', 'yes')
    setPendingQuestionAnswer('s1', 'q2', ['a', 'b'])
    expect(getPendingQuestionAnswers('s1')).toEqual({ q1: 'yes', q2: ['a', 'b'] })
  })

  it('setPendingQuestionAnswer 不可变更新（产生新对象）', () => {
    seedSession()
    const store = getSessionStore('s1').store
    const before = store.getter(pendingQuestionAnswersAtom)
    setPendingQuestionAnswer('s1', 'q1', true)
    const after = store.getter(pendingQuestionAnswersAtom)
    expect(after).not.toBe(before)
  })

  it('clearPendingQuestionAnswers 清空该会话答案', () => {
    seedSession()
    setPendingQuestionAnswer('s1', 'q1', 'yes')
    clearPendingQuestionAnswers('s1')
    expect(getPendingQuestionAnswers('s1')).toEqual({})
  })

  it('未登记会话 → setPendingQuestionAnswer no-op（C7）', () => {
    setPendingQuestionAnswer('sX', 'q1', 'yes')
    expect(getSessionStore('sX').store.getter(pendingQuestionAnswersAtom)).toEqual({})
  })

  it('两个会话答案互相隔离（不分桶）', () => {
    seedSession('s1')
    seedSession('s2')
    // seedSession 覆盖式写入，重新登记两个会话
    rootStore.setter(sessionsAtom, {
      s1: { id: 's1', title: 't', settings: { vendor: 'deepseek', model: 'x' }, createdAt: 0, updatedAt: 0 },
      s2: { id: 's2', title: 't', settings: { vendor: 'deepseek', model: 'x' }, createdAt: 0, updatedAt: 0 },
    })
    setPendingQuestionAnswer('s1', 'q1', 'one')
    setPendingQuestionAnswer('s2', 'q1', 'two')
    expect(getPendingQuestionAnswers('s1')).toEqual({ q1: 'one' })
    expect(getPendingQuestionAnswers('s2')).toEqual({ q1: 'two' })
  })
})

describe('alwaysAllowedTools（S4-B 本 session 一律允许的危险工具）', () => {
  it('addAlwaysAllowedTool：写入 + 去重；isToolAlwaysAllowed 命中', () => {
    seedSession('s1')
    expect(isToolAlwaysAllowed('s1', 'write_file')).toBe(false)

    addAlwaysAllowedTool('s1', 'write_file')
    addAlwaysAllowedTool('s1', 'write_file') // 去重
    addAlwaysAllowedTool('s1', 'shell_macos')

    expect(getSessionStore('s1').store.getter(alwaysAllowedToolsAtom)).toEqual(['write_file', 'shell_macos'])
    expect(isToolAlwaysAllowed('s1', 'write_file')).toBe(true)
    expect(isToolAlwaysAllowed('s1', 'apply_patch')).toBe(false)
  })

  it('未登记会话 → addAlwaysAllowedTool no-op（ghost guard）；isToolAlwaysAllowed 取 [] → false', () => {
    addAlwaysAllowedTool('sX', 'write_file')
    expect(getSessionStore('sX').store.getter(alwaysAllowedToolsAtom)).toEqual([])
    expect(isToolAlwaysAllowed('sX', 'write_file')).toBe(false)
  })

  it('MCP 工具拒绝写入；即使 atom 被直接污染也永远不视为 session 已授权', () => {
    seedSession('mcp-session')
    const store = getSessionStore('mcp-session').store
    const mcpTool = 'mcp__playwright__browser_navigate'

    addAlwaysAllowedTool('mcp-session', mcpTool)
    expect(store.getter(alwaysAllowedToolsAtom)).toEqual([])

    store.setter(alwaysAllowedToolsAtom, [mcpTool, 'write_file'])
    expect(isToolAlwaysAllowed('mcp-session', mcpTool)).toBe(false)
    expect(isToolAlwaysAllowed('mcp-session', 'write_file')).toBe(true)
  })
})

describe('composerDraft / withdrawnTurnNotice', () => {
  it('setComposerDraft 写入当前会话草稿，值随 store 隔离', () => {
    rootStore.setter(sessionsAtom, {
      s1: { id: 's1', title: 't', settings: { vendor: 'deepseek', model: 'x' }, createdAt: 0, updatedAt: 0 },
      s2: { id: 's2', title: 't', settings: { vendor: 'deepseek', model: 'x' }, createdAt: 0, updatedAt: 0 },
    })

    setComposerDraft('s1', 'hello')

    expect(getSessionStore('s1').store.getter(composerDraftAtom)).toBe('hello')
    expect(getSessionStore('s2').store.getter(composerDraftAtom)).toBe('')
  })

  it('setWithdrawnTurnNotice 写入/清除撤回提示', () => {
    seedSession()
    const notice = { id: 'n1', createdAt: 1, text: '已撤回', sideEffects: true }

    setWithdrawnTurnNotice('s1', notice)
    expect(getSessionStore('s1').store.getter(withdrawnTurnNoticeAtom)).toEqual(notice)

    setWithdrawnTurnNotice('s1', undefined)
    expect(getSessionStore('s1').store.getter(withdrawnTurnNoticeAtom)).toBeUndefined()
  })

  it('未登记会话 → draft/notice writer no-op', () => {
    setComposerDraft('sX', 'ghost')
    setWithdrawnTurnNotice('sX', { id: 'n', createdAt: 1, text: 'x', sideEffects: false })

    expect(getSessionStore('sX').store.getter(composerDraftAtom)).toBe('')
    expect(getSessionStore('sX').store.getter(withdrawnTurnNoticeAtom)).toBeUndefined()
  })
})

describe('contextStatsAtom', () => {
  const sampleStats: ContextStatsSnapshot = {
    id: 'ctx1',
    createdAt: 1,
    vendor: 'deepseek',
    model: 'x',
    runId: 'r1',
    turnId: 'u1',
    llmTurn: 1,
    messagesCount: 2,
    toolsCount: 1,
    systemChars: 10,
    messagesChars: 20,
    toolsChars: 30,
    totalChars: 50,
    estimatedTokens: 13,
    roles: {
      system: { count: 1, chars: 10, estimatedTokens: 3 },
      user: { count: 1, chars: 10, estimatedTokens: 3 },
      assistant: { count: 0, chars: 0, estimatedTokens: 0 },
      tool: { count: 0, chars: 0, estimatedTokens: 0 },
    },
    toolNames: ['request_tool_schema'],
  }

  it('setContextStats 写入/清除当前会话统计', () => {
    seedSession()

    setContextStats('s1', sampleStats)
    expect(getSessionStore('s1').store.getter(contextStatsAtom)).toEqual(sampleStats)

    setContextStats('s1', undefined)
    expect(getSessionStore('s1').store.getter(contextStatsAtom)).toBeUndefined()
  })

  it('未登记会话 → setContextStats no-op', () => {
    setContextStats('sX', sampleStats)

    expect(getSessionStore('sX').store.getter(contextStatsAtom)).toBeUndefined()
    expect(rootStore.getter(sessionsAtom).sX).toBeUndefined()
  })
})

// 【实例化 · 第 2 期穿线】写入器新增的 core 参数（默认 defaultCore）—— 传入 createCoreInstance()
// 造的独立 core 时，读写应只落在那个 core 自己的 rootStore / session store，与 defaultCore
// （模块级 rootStore / getSessionStore 背后指向的那一份）互不污染。这是第 3 期真正隔离前的雏形验证：
// 也顺带证明 ghost guard 判定的是【传入 core】的登记表，而不是永远查 defaultCore。
describe('core 参数穿线（第 2 期）—— 传入独立 core 时读写隔离，不污染 defaultCore', () => {
  it('addPendingArtifact 传入独立 core：写入落在该 core 的 store；defaultCore 一侧（模块级 rootStore/getSessionStore）不受影响', () => {
    const core = createCoreInstance()
    // 只在【独立 core】的 rootStore 登记 s1 —— defaultCore（= 模块级 rootStore）里完全没有这个会话。
    core.rootStore.setter(sessionsAtom, {
      s1: { id: 's1', title: 't', settings: { vendor: 'deepseek', model: 'x' }, createdAt: 0, updatedAt: 0 },
    })

    addPendingArtifact('s1', sampleArtifact, core)

    // 写入确实落进了独立 core 自己的 session store。
    expect(core.getSessionStore('s1').store.getter(pendingArtifactsAtom)).toEqual([sampleArtifact])

    // defaultCore 一侧：s1 从未在 defaultCore.rootStore（= 顶层 rootStore）登记过，
    // 模块级 getSessionStore('s1') 取到的是 defaultCore 私有 Map 里的 store —— 应该仍是空数组。
    expect(getSessionStore('s1').store.getter(pendingArtifactsAtom)).toEqual([])
    expect(rootStore.getter(sessionsAtom).s1).toBeUndefined()
  })

  it('未在独立 core 登记会话 → 传入该 core 仍被 ghost guard 拦下（guard 查的是传入 core 的登记表，不是「传了 core 就跳过 guard」）', () => {
    const core = createCoreInstance()
    // 故意不在 core.rootStore 登记 s2：即便传入了一个「有效」的 core，未登记会话仍应 no-op。
    addBrowserCard('s2', sampleCard, core)
    expect(core.getSessionStore('s2').store.getter(browserCardsAtom)).toEqual([])
  })
})

// 【实例化 · 第 3 期穿线】本文件仅剩的两个纯读函数（第 2 期未穿）也补了尾参 core（默认 defaultCore）：
// getPendingQuestionAnswers / isToolAlwaysAllowed 现在经 core.getSessionStore(id) 读，不再摸模块级
// getSessionStore。传入 createCoreInstance() 造的独立 core 时，只应读到该 core 自己 session store 里
// 写入器（同样已支持 core 尾参）落下的值；模块级（defaultCore）一侧对同一 id 应仍是初始默认值——
// 这是第 3 期「两个隔离实例互不串台」证明的另一部分（写路径 + 读路径都验过隔离）。
describe('getPendingQuestionAnswers / isToolAlwaysAllowed —— core 参数隔离（第 3 期读函数补线）', () => {
  it('传入独立 core：getPendingQuestionAnswers 读到该 core 自己写入的答案；defaultCore 一侧仍是空对象', () => {
    const core = createCoreInstance()
    const id = 's1'
    core.rootStore.setter(sessionsAtom, {
      [id]: { id, title: 't', settings: { vendor: 'deepseek', model: 'x' }, createdAt: 0, updatedAt: 0 },
    })

    // 写入器（第 2 期已支持 core 尾参）落到独立 core 自己的 session store。
    setPendingQuestionAnswer(id, 'q1', 'from-isolated-core', core)

    expect(getPendingQuestionAnswers(id, core)).toEqual({ q1: 'from-isolated-core' })

    // defaultCore 一侧：s1 从未在 defaultCore.rootStore（= 顶层 rootStore）登记过，
    // 不传 core（走模块级 getSessionStore）读到的应仍是初始空对象——没有被独立 core 的写入污染。
    expect(getPendingQuestionAnswers(id)).toEqual({})
    expect(rootStore.getter(sessionsAtom)[id]).toBeUndefined()
  })

  it('传入独立 core：isToolAlwaysAllowed 只认该 core 自己「一律允许」的记录；defaultCore 一侧仍为 false', () => {
    const core = createCoreInstance()
    const id = 's1'
    core.rootStore.setter(sessionsAtom, {
      [id]: { id, title: 't', settings: { vendor: 'deepseek', model: 'x' }, createdAt: 0, updatedAt: 0 },
    })

    addAlwaysAllowedTool(id, 'write_file', core)

    expect(isToolAlwaysAllowed(id, 'write_file', core)).toBe(true)

    // defaultCore 一侧（不传 core）：同一 id 从未在 defaultCore 登记过、也没写过 alwaysAllowedTools，
    // 应仍判 false —— 证明独立 core 的「一律允许」记录没有泄漏进 defaultCore。
    expect(isToolAlwaysAllowed(id, 'write_file')).toBe(false)
  })

  it('未在独立 core 登记会话 → 两个读函数仍安全返回默认值（不复活幽灵会话，不崩）', () => {
    const core = createCoreInstance()
    // 故意不登记 'ghost'：getSessionStore 仍会按需建一个空 store，读到默认值，不抛错。
    expect(getPendingQuestionAnswers('ghost', core)).toEqual({})
    expect(isToolAlwaysAllowed('ghost', 'write_file', core)).toBe(false)
  })
})
