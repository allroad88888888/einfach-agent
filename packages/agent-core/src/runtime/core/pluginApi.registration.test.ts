import { createStore, type Atom, type Store } from '@einfach/core'
import { describe, expect, it, vi } from 'vitest'

import { itemsAtom, runAtom } from '../../state/sessionAtoms'
import type { ConversationItem } from '../../state/core.type'
import type { Tool } from '../../tools/types'
import type { CoreCtx } from './coreCtx'
import type { TurnEndEvent } from './loopHooks'
import { assemblePlugins, type AgentPlugin } from './pluginApi'

const ctx = { sessionId: 's', runId: 'r' } as unknown as CoreCtx

function fakeTool(name: string): Tool {
  return {
    name,
    runtime: 'internal',
    skill: { description: `${name} 摘要`, content: `${name} 指南` },
    inputSchema: {},
    execute: () => ({ ok: true }),
  }
}

function fakeItem(id: string, content: string): ConversationItem {
  return { id, createdAt: 0, item: { role: 'user', content } }
}

function turnEndEvent(over: Partial<TurnEndEvent> = {}): TurnEndEvent {
  return { finishReason: null, toolCalls: [], assistantHasContent: false, msg: undefined, hasStreamedItem: false, ...over }
}

function watchSub(store: Store): { store: Store; subSpy: ReturnType<typeof vi.fn> } {
  const subSpy = vi.fn((atom: Atom<unknown>, listener: () => void) => store.sub(atom, listener))
  return { store: { ...store, sub: subSpy as unknown as Store['sub'] }, subSpy }
}

describe('registerTool —— 收集插件注册的工具（PX2），不碰任何全局 registry', () => {
  it('无插件注册 tool → tools 为空数组（是清单不是槽，空态用 [] 不是 undefined）', () => {
    expect(assemblePlugins([]).tools).toEqual([])
  })

  it('单个插件注册单个 tool → 原样出现在 tools 里', () => {
    const tool = fakeTool('t1')
    expect(assemblePlugins([(api) => api.registerTool(tool)]).tools).toEqual([tool])
  })

  it('多个插件按插件数组序与插件内调用序合并工具', () => {
    const a1 = fakeTool('a1')
    const a2 = fakeTool('a2')
    const b1 = fakeTool('b1')
    const pluginA: AgentPlugin = (api) => { api.registerTool(a1); api.registerTool(a2) }
    expect(assemblePlugins([pluginA, (api) => api.registerTool(b1)]).tools).toEqual([a1, a2, b1])
  })

  it('registerTool 与 hook 独立生效', async () => {
    const tool = fakeTool('mix')
    const hooks = assemblePlugins([(api) => { api.registerTool(tool); api.hook('shouldStop', () => true) }])
    expect(hooks.tools).toEqual([tool])
    expect(await hooks.shouldStop?.(ctx)).toBe(true)
    expect(hooks.beforeToolCall).toBeUndefined()
  })
})

describe('subscribe / bindSubscriptions —— 装配期只记意向，真订阅推迟到 bind', () => {
  it('bind 前不碰 store.sub；调用后为每条意向各调一次', () => {
    const { store, subSpy } = watchSub(createStore())
    const hooks = assemblePlugins([(api) => api.subscribe(runAtom, vi.fn()), (api) => api.subscribe(itemsAtom, vi.fn())])
    expect(subSpy).not.toHaveBeenCalled()
    hooks.bindSubscriptions(store)
    expect(subSpy).toHaveBeenCalledTimes(2)
  })

  it('bind 前的变化不补发，之后每次变化取最新值', () => {
    const store = createStore()
    store.setter(runAtom, { runId: 'r0', status: 'running' })
    const seen: unknown[] = []
    assemblePlugins([(api) => api.subscribe(runAtom, (value) => seen.push(value))]).bindSubscriptions(store)
    store.setter(runAtom, { runId: 'r1', status: 'running' })
    store.setter(runAtom, { runId: 'r1', status: 'done' })
    expect(seen).toEqual([{ runId: 'r1', status: 'running' }, { runId: 'r1', status: 'done' }])
  })

  it('同一 atom 的多条订阅独立触发，dispose 后不再触发', () => {
    const store = createStore()
    const runSeen: unknown[] = []
    const itemsSeen: unknown[] = []
    const hooks = assemblePlugins([
      (api) => api.subscribe(runAtom, (value) => runSeen.push(value)),
      (api) => api.subscribe(runAtom, (value) => runSeen.push(value)),
      (api) => api.subscribe(itemsAtom, (value) => itemsSeen.push(value)),
    ])
    const dispose = hooks.bindSubscriptions(store)
    store.setter(runAtom, { runId: 'r1', status: 'running' })
    store.setter(itemsAtom, [fakeItem('i1', 'hi')])
    expect(runSeen).toEqual([{ runId: 'r1', status: 'running' }, { runId: 'r1', status: 'running' }])
    expect(itemsSeen).toEqual([[fakeItem('i1', 'hi')]])
    dispose()
    store.setter(runAtom, { runId: 'r1', status: 'done' })
    expect(runSeen).toHaveLength(2)
  })

  it('无订阅时返回安全 no-op disposer', () => {
    expect(() => assemblePlugins([]).bindSubscriptions(createStore())()).not.toThrow()
  })
})

describe('多插件混注册 —— hook / subscribe / registerTool 互不干扰', () => {
  it('三类能力可分别或一起注册并独立生效', async () => {
    const store = createStore()
    const toolA = fakeTool('a')
    const toolB = fakeTool('b')
    const seen: string[] = []
    const hooks = assemblePlugins([
      (api) => api.registerTool(toolA),
      (api) => api.hook('shouldStop', () => true),
      (api) => api.subscribe(runAtom, () => seen.push('subscribed')),
      (api) => api.registerTool(toolB),
      (api) => api.hook('onTurnEnd', () => void seen.push('turn-end')),
    ])
    hooks.bindSubscriptions(store)
    expect(hooks.tools).toEqual([toolA, toolB])
    expect(await hooks.shouldStop?.(ctx)).toBe(true)
    await hooks.onTurnEnd?.(ctx, turnEndEvent())
    store.setter(runAtom, { runId: 'r1', status: 'running' })
    expect(seen).toEqual(['turn-end', 'subscribed'])
  })
})
