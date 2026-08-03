import { describe, expect, it, vi } from 'vitest'
import { createStore } from '@einfach/core'

import { sessionsAtom } from '../../state/rootStore'
import { runAtom } from '../../state/sessionAtoms'
import type { SessionMeta } from '../../state/core.type'
import { makeCoreCtx } from './coreCtx'
import { isCurrentRun } from '../shared/runGuards'

// isCurrentRun 只查会话登记的「存在性」与 run 的 runId，故最小可信 meta 即可（只需真值）。
function fakeMeta(id: string): SessionMeta {
  return { id } as unknown as SessionMeta
}

describe('isCurrentRun（ghost + stale 双查）', () => {
  it('会话已登记且当前 run 匹配 → true', () => {
    const root = createStore()
    const store = createStore()
    root.setter(sessionsAtom, { s1: fakeMeta('s1') })
    store.setter(runAtom, { runId: 'r1', status: 'running' })

    expect(isCurrentRun({ root, getStore: () => store, sessionId: 's1', runId: 'r1' })).toBe(true)
  })

  it('ghost：会话未登记 → false（即便 runAtom 恰好匹配）', () => {
    const root = createStore() // sessionsAtom 默认 {}
    const store = createStore()
    store.setter(runAtom, { runId: 'r1', status: 'running' })

    expect(isCurrentRun({ root, getStore: () => store, sessionId: 's1', runId: 'r1' })).toBe(false)
  })

  it('ghost：不读取 session store，避免为已删除会话创建 store', () => {
    const root = createStore()
    const getStore = vi.fn(() => createStore())

    expect(isCurrentRun({ root, getStore, sessionId: 's1', runId: 'r1' })).toBe(false)
    expect(getStore).not.toHaveBeenCalled()
  })

  it('stale：run 被新 run 顶掉（runId 不同）→ false', () => {
    const root = createStore()
    const store = createStore()
    root.setter(sessionsAtom, { s1: fakeMeta('s1') })
    store.setter(runAtom, { runId: 'r2', status: 'running' })

    expect(isCurrentRun({ root, getStore: () => store, sessionId: 's1', runId: 'r1' })).toBe(false)
  })

  it('无 run（runAtom 为 undefined）→ false', () => {
    const root = createStore()
    const store = createStore()
    root.setter(sessionsAtom, { s1: fakeMeta('s1') })
    // runAtom 保持默认 undefined

    expect(isCurrentRun({ root, getStore: () => store, sessionId: 's1', runId: 'r1' })).toBe(false)
  })

  it('只认本会话自己的 store —— 另一会话 store 的 run 不参与判定', () => {
    const root = createStore()
    const storeA = createStore()
    const storeB = createStore()
    root.setter(sessionsAtom, { s1: fakeMeta('s1') })
    storeB.setter(runAtom, { runId: 'r1', status: 'running' }) // 放错 store

    // storeA 里没有 run → false（证明 run 的真相在传入的 store，不是全局）
    expect(isCurrentRun({ root, getStore: () => storeA, sessionId: 's1', runId: 'r1' })).toBe(false)
    expect(isCurrentRun({ root, getStore: () => storeB, sessionId: 's1', runId: 'r1' })).toBe(true)
  })
})

describe('makeCoreCtx（PX1 组装器）', () => {
  it('原样透出注入的 sessionId/runId/signal/store/root', () => {
    const root = createStore()
    const store = createStore()
    const signal = new AbortController().signal
    const ctx = makeCoreCtx({ sessionId: 's1', runId: 'r1', signal, root, store, traceEvent: () => {} })

    expect(ctx.sessionId).toBe('s1')
    expect(ctx.runId).toBe('r1')
    expect(ctx.signal).toBe(signal)
    expect(ctx.store).toBe(store)
    expect(ctx.root).toBe(root)
  })

  it('isCurrent() 委托到 isCurrentRun：当前 → true，会话被 drop（ghost）后 → false', () => {
    const root = createStore()
    const store = createStore()
    const ctx = makeCoreCtx({
      sessionId: 's1',
      runId: 'r1',
      signal: new AbortController().signal,
      root,
      store,
      traceEvent: () => {},
    })
    root.setter(sessionsAtom, { s1: fakeMeta('s1') })
    store.setter(runAtom, { runId: 'r1', status: 'running' })
    expect(ctx.isCurrent()).toBe(true)

    root.setter(sessionsAtom, {}) // 会话消失
    expect(ctx.isCurrent()).toBe(false)
  })

  it('isCurrent()：run 被顶掉（stale）后 → false', () => {
    const root = createStore()
    const store = createStore()
    const ctx = makeCoreCtx({
      sessionId: 's1',
      runId: 'r1',
      signal: new AbortController().signal,
      root,
      store,
      traceEvent: () => {},
    })
    root.setter(sessionsAtom, { s1: fakeMeta('s1') })
    store.setter(runAtom, { runId: 'rX', status: 'running' })
    expect(ctx.isCurrent()).toBe(false)
  })

  it('traceEvent 原样透传注入的回调（name/attrs 逐字），且保留函数身份', () => {
    const traceEvent = vi.fn()
    const ctx = makeCoreCtx({
      sessionId: 's1',
      runId: 'r1',
      signal: new AbortController().signal,
      root: createStore(),
      store: createStore(),
      traceEvent,
    })

    ctx.traceEvent('llm.context_compacted', { llm_turn: 3, budget_tk: 200_000 })
    expect(traceEvent).toHaveBeenCalledTimes(1)
    expect(traceEvent).toHaveBeenCalledWith('llm.context_compacted', { llm_turn: 3, budget_tk: 200_000 })

    // 直接透传（非包一层）：便于测试断言收到的参数，也不引入无谓的间接层。
    expect(ctx.traceEvent).toBe(traceEvent)

    // attrs 省略也应透传给回调（attrs 为可选）。
    ctx.traceEvent('llm.system_injected')
    expect(traceEvent).toHaveBeenLastCalledWith('llm.system_injected')
  })
})
