import { afterEach, describe, expect, it } from 'vitest'
import { createStore } from '@einfach/core'

import { rootStore, sessionsAtom, resetRootStore } from './rootStore'
import { getSessionStore, resetSessionStores } from './sessionStore'
import {
  pendingArtifactsAtom,
  browserCardsAtom,
  pendingQuestionAnswersAtom,
  addPendingArtifact,
  addBrowserCard,
  setPendingQuestionAnswer,
  getPendingQuestionAnswers,
  clearPendingQuestionAnswers,
  type PendingArtifact,
  type BrowserCard,
} from './transientAtoms'

// TK5 瞬态 atom —— 单测先行（C6）。三个 atom 是「会话 store 内共享单例 key」，
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
