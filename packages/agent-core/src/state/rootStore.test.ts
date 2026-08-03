import { describe, it, expect } from 'vitest'
import type { SessionMeta } from './core.type'
import {
  rootStore,
  sessionsAtom,
  activeSessionIdAtom,
  activeSessionMetaAtom,
  resetRootStore,
} from './rootStore'

// 会话元信息样例：DeepSeek 设置最小合法字面量。
const meta: SessionMeta = {
  id: 's1',
  title: 't',
  settings: { vendor: 'deepseek', model: 'x' },
  createdAt: 0,
  updatedAt: 0,
}

describe('rootStore', () => {
  it('activeSessionMetaAtom 反映当前会话元信息', () => {
    rootStore.setter(sessionsAtom, { s1: meta })
    rootStore.setter(activeSessionIdAtom, 's1')

    expect(rootStore.getter(activeSessionMetaAtom)).toEqual(meta)
  })

  it('activeSessionId 指向未知会话 → activeSessionMetaAtom 为 undefined', () => {
    rootStore.setter(sessionsAtom, { s1: meta })
    rootStore.setter(activeSessionIdAtom, 's9')

    expect(rootStore.getter(activeSessionMetaAtom)).toBeUndefined()
  })

  it('resetRootStore 清空 sessionsAtom 与 activeSessionIdAtom', () => {
    rootStore.setter(sessionsAtom, { s1: meta })
    rootStore.setter(activeSessionIdAtom, 's1')

    resetRootStore()

    expect(rootStore.getter(sessionsAtom)).toEqual({})
    expect(rootStore.getter(activeSessionIdAtom)).toBe('')
    expect(rootStore.getter(activeSessionMetaAtom)).toBeUndefined()
  })
})
