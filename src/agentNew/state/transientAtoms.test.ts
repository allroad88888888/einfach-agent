import { afterEach, describe, expect, it } from 'vitest'
import { createStore } from '@einfach/core'

import { rootStore, sessionsAtom, resetRootStore } from './rootStore'
import { getSessionStore, resetSessionStores } from './sessionStore'
import {
  pendingArtifactsAtom,
  browserCardsAtom,
  pendingQuestionAnswersAtom,
  alwaysAllowedToolsAtom,
  composerDraftAtom,
  withdrawnTurnNoticeAtom,
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
  setWithdrawnTurnNotice,
  type PendingArtifact,
  type BrowserCard,
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
    expect(b.getter(withdrawnTurnNoticeAtom)).toBeUndefined()
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
