import { describe, expect, it, vi } from 'vitest'
import { createStore, type Atom, type Store } from '@einfach/core'

import type { ModelItem, UserItem } from '@web-agent/ai'
import { itemsAtom, runAtom } from '../../state/sessionAtoms'
import type { ConversationItem } from '../../state/core.type'
import type { Tool } from '../../tools/types'
import type { CoreCtx } from './coreCtx'
import type { RequestDraft, TurnEndEvent } from './loopHooks'
import { assemblePlugins, type AgentPlugin } from './pluginApi'

// 组合逻辑不读 ctx，用最小假 ctx 即可（makeCoreCtx 的接线由 coreCtx.test 覆盖）。
const ctx = { sessionId: 's', runId: 'r' } as unknown as CoreCtx

function user(content: string): UserItem {
  return { role: 'user', content }
}

function draftOf(...contents: string[]): RequestDraft {
  return { messages: contents.map(user) as ModelItem[] }
}

function contentsOf(draft: RequestDraft): string[] {
  return draft.messages.map((m) => (m as UserItem).content)
}

function turnEndEvent(over: Partial<TurnEndEvent> = {}): TurnEndEvent {
  return {
    finishReason: null,
    toolCalls: [],
    assistantHasContent: false,
    msg: undefined,
    hasStreamedItem: false,
    ...over,
  }
}

// registerTool 测试用的最小合法 Tool——字段齐全但内容是占位符，组合逻辑不关心工具语义。
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
  return { id, createdAt: 0, item: user(content) }
}

// createStore() 出的 store 会在构造尾声把自己写进 storeAtom（einfach 内部机制），dev 下非 Promise
// 状态一律 Object.freeze——store 自身因此被冻结，vi.spyOn(store, 'sub') 会报 "Cannot redefine
// property"。用一个转发到真实 store 的新对象字面量代替直接 spyOn：新对象本身不冻结，sub 换成
// 包一层 vi.fn 的转发（真订阅行为不变，只是多记了调用），getter/setter 直接透传同一个闭包，
// 仍操作同一份内部状态——两者是同一个 store 的两个入口，不是分裂出两份独立状态。
function watchSub(store: Store): { store: Store; subSpy: ReturnType<typeof vi.fn> } {
  const subSpy = vi.fn((atom: Atom<unknown>, listener: () => void) => store.sub(atom, listener))
  return { store: { ...store, sub: subSpy as unknown as Store['sub'] }, subSpy }
}

describe('assemblePlugins —— 空 / 单槽为 undefined', () => {
  it('无插件 → 七个槽全为 undefined', () => {
    const hooks = assemblePlugins([])
    expect(hooks.onRunStart).toBeUndefined()
    expect(hooks.transformContext).toBeUndefined()
    expect(hooks.prepareRequest).toBeUndefined()
    expect(hooks.beforeToolCall).toBeUndefined()
    expect(hooks.afterToolCall).toBeUndefined()
    expect(hooks.onTurnEnd).toBeUndefined()
    expect(hooks.shouldStop).toBeUndefined()
  })

  it('只注册 transformContext → 其余六槽为 undefined（loop 侧据此跳过）', () => {
    const hooks = assemblePlugins([(api) => api.hook('transformContext', () => {})])
    expect(hooks.transformContext).toBeDefined()
    expect(hooks.onRunStart).toBeUndefined()
    expect(hooks.prepareRequest).toBeUndefined()
    expect(hooks.beforeToolCall).toBeUndefined()
    expect(hooks.afterToolCall).toBeUndefined()
    expect(hooks.onTurnEnd).toBeUndefined()
    expect(hooks.shouldStop).toBeUndefined()
  })
})

describe('onRunStart —— run 启动、首轮请求前，按注册序依次 await', () => {
  it('多个 onRunStart 按注册序生效（含异步：后者等前者跑完）', async () => {
    const order: string[] = []
    const pluginA: AgentPlugin = (api) =>
      api.hook('onRunStart', async () => {
        await Promise.resolve() // 先让出一个微任务，若非串行 await 则顺序会乱
        order.push('A')
      })
    const pluginB: AgentPlugin = (api) => api.hook('onRunStart', () => void order.push('B'))

    const hooks = assemblePlugins([pluginA, pluginB])
    await hooks.onRunStart?.(ctx)
    expect(order).toEqual(['A', 'B'])
  })

  it('把调用方传入的 ctx 原样交给每个 hook', async () => {
    const got: CoreCtx[] = []
    const hooks = assemblePlugins([
      (api) => api.hook('onRunStart', (c) => void got.push(c)),
      (api) => api.hook('onRunStart', (c) => void got.push(c)),
    ])
    await hooks.onRunStart?.(ctx)
    expect(got).toEqual([ctx, ctx])
  })

  it('无人注册 onRunStart → 该槽为 undefined（loop 侧据此跳过）', () => {
    const hooks = assemblePlugins([(api) => api.hook('shouldStop', () => true)])
    expect(hooks.onRunStart).toBeUndefined()
  })
})

describe('transformContext —— 按注册序依次 await，都能改 draft', () => {
  it('多个插件按注册序生效（含异步：后者等前者跑完）', async () => {
    const order: string[] = []
    const pluginA: AgentPlugin = (api) =>
      api.hook('transformContext', async (_c, draft) => {
        await Promise.resolve() // 先让出一个微任务，若非串行 await 则顺序会乱
        order.push('A')
        draft.messages.push(user('A'))
      })
    const pluginB: AgentPlugin = (api) =>
      api.hook('transformContext', (_c, draft) => {
        order.push('B')
        draft.messages.push(user('B'))
      })

    const hooks = assemblePlugins([pluginA, pluginB])
    const draft = draftOf()
    await hooks.transformContext?.(ctx, draft)

    expect(order).toEqual(['A', 'B'])
    expect(contentsOf(draft)).toEqual(['A', 'B'])
  })

  it('把调用方传入的 ctx 原样交给每个 hook', async () => {
    const got: CoreCtx[] = []
    const hooks = assemblePlugins([
      (api) => api.hook('transformContext', (c) => void got.push(c)),
      (api) => api.hook('transformContext', (c) => void got.push(c)),
    ])
    await hooks.transformContext?.(ctx, draftOf())
    expect(got).toEqual([ctx, ctx])
  })
})

describe('prepareRequest —— 同 transformContext：按注册序依次 await 改 draft', () => {
  it('两个 prepareRequest 顺序追加', async () => {
    const hooks = assemblePlugins([
      (api) => api.hook('prepareRequest', (_c, d) => void d.messages.push(user('1'))),
      (api) => api.hook('prepareRequest', (_c, d) => void d.messages.push(user('2'))),
    ])
    const draft = draftOf()
    await hooks.prepareRequest?.(ctx, draft)
    expect(contentsOf(draft)).toEqual(['1', '2'])
  })
})

describe('beforeToolCall —— 第一个 {block:true} 胜、短路', () => {
  it('返回首个 block 结果，且其后的 hook 不再被调', async () => {
    const calls: string[] = []
    const hooks = assemblePlugins([
      (api) =>
        api.hook('beforeToolCall', () => {
          calls.push('A')
          return undefined
        }),
      (api) =>
        api.hook('beforeToolCall', () => {
          calls.push('B')
          return { block: true, reason: 'B' }
        }),
      (api) =>
        api.hook('beforeToolCall', () => {
          calls.push('C')
          return { block: true, reason: 'C' }
        }),
    ])

    const res = await hooks.beforeToolCall?.(ctx, { toolCall: 't', args: {} })
    expect(res).toEqual({ block: true, reason: 'B' })
    expect(calls).toEqual(['A', 'B']) // C 被短路
  })

  it('无人 block（含 block:false）→ 返回 undefined', async () => {
    const hooks = assemblePlugins([
      (api) => api.hook('beforeToolCall', () => undefined),
      (api) => api.hook('beforeToolCall', () => ({ block: false, reason: '仅记录' })),
    ])
    const res = await hooks.beforeToolCall?.(ctx, { toolCall: 't', args: {} })
    expect(res).toBeUndefined()
  })

  it('异步 hook 也串行 await（block 判定在 await 之后）', async () => {
    const hooks = assemblePlugins([
      (api) =>
        api.hook('beforeToolCall', async () => {
          await Promise.resolve()
          return { block: true, reason: 'async' }
        }),
    ])
    expect(await hooks.beforeToolCall?.(ctx, { toolCall: 't', args: {} })).toEqual({
      block: true,
      reason: 'async',
    })
  })
})

describe('afterToolCall —— 按注册序逐字段覆盖合并（omit 保留原值）+ 改写管道', () => {
  it('字段覆盖 / 新增 / omit 保留；且每环见到上一环的累积结果', async () => {
    const seen: unknown[] = []
    const hooks = assemblePlugins([
      (api) =>
        api.hook('afterToolCall', (_c, ev) => {
          seen.push(ev.result)
          return { a: 1, shared: 'A' } // 新增 a、shared
        }),
      (api) =>
        api.hook('afterToolCall', (_c, ev) => {
          seen.push(ev.result)
          return { b: 2, shared: 'B', a: undefined } // 覆盖 shared、新增 b、a=undefined 视作 omit
        }),
    ])

    const out = await hooks.afterToolCall?.(ctx, { toolCall: 't', result: { orig: 0 } })
    // orig 保留；a 保留（第二环 a:undefined 不覆盖）；shared 被覆盖成 B；b 新增。
    expect(out).toEqual({ orig: 0, a: 1, shared: 'B', b: 2 })

    // 改写管道：第一环见到原始结果，第二环见到第一环合并后的累积值（threading）。
    expect(seen[0]).toEqual({ orig: 0 })
    expect(seen[1]).toEqual({ orig: 0, a: 1, shared: 'A' })
  })

  it('patch 为 undefined → 保留累积结果（该 hook 不改结果）', async () => {
    const hooks = assemblePlugins([(api) => api.hook('afterToolCall', () => undefined)])
    const out = await hooks.afterToolCall?.(ctx, { toolCall: 't', result: { a: 1 } })
    expect(out).toEqual({ a: 1 })
  })

  it('patch 为非对象 → 整体替换累积结果', async () => {
    const hooks = assemblePlugins([(api) => api.hook('afterToolCall', () => 'replaced')])
    const out = await hooks.afterToolCall?.(ctx, { toolCall: 't', result: { a: 1 } })
    expect(out).toBe('replaced')
  })

  it('不改动调用方传入的原始 result 对象（合并产出新对象）', async () => {
    const original = { a: 1 }
    const hooks = assemblePlugins([(api) => api.hook('afterToolCall', () => ({ a: 2 }))])
    const out = await hooks.afterToolCall?.(ctx, { toolCall: 't', result: original })
    expect(out).toEqual({ a: 2 })
    expect(original).toEqual({ a: 1 }) // 原对象未被就地改写
  })
})

describe('onTurnEnd —— 按注册序依次 await', () => {
  it('多个 onTurnEnd 顺序执行', async () => {
    const order: string[] = []
    const hooks = assemblePlugins([
      (api) =>
        api.hook('onTurnEnd', async () => {
          await Promise.resolve()
          order.push('A')
        }),
      (api) => api.hook('onTurnEnd', () => void order.push('B')),
    ])
    const decision = await hooks.onTurnEnd?.(ctx, turnEndEvent({ finishReason: 'stop' }))
    expect(order).toEqual(['A', 'B'])
    // 全部返回 void → 无决策 → 复合 onTurnEnd 返回 undefined（loop 继续）。
    expect(decision).toBeUndefined()
  })
})

describe('onTurnEnd —— 决策合并：首个 stop:true 胜且短路', () => {
  it('返回首个 stop 决策（整份带出其 runStatus/reason），其后的 hook 不再被调', async () => {
    const calls: string[] = []
    const hooks = assemblePlugins([
      (api) =>
        api.hook('onTurnEnd', () => {
          calls.push('A') // 观察型：返回 void，不干预
        }),
      (api) =>
        api.hook('onTurnEnd', () => {
          calls.push('B')
          return { stop: true, runStatus: 'error', reason: 'B', traceEventName: 'agent.test_b' }
        }),
      (api) =>
        api.hook('onTurnEnd', () => {
          calls.push('C')
          return { stop: true, runStatus: 'stopped', reason: 'C', traceEventName: 'agent.test_c' }
        }),
    ])

    const decision = await hooks.onTurnEnd?.(ctx, turnEndEvent({ finishReason: 'length' }))
    expect(decision).toEqual({
      stop: true,
      runStatus: 'error',
      reason: 'B',
      traceEventName: 'agent.test_b',
    })
    expect(calls).toEqual(['A', 'B']) // C 被短路
  })

  it('无人 stop（含返回 void / {stop:false} / 空决策）→ undefined，全部执行不短路', async () => {
    const calls: string[] = []
    const hooks = assemblePlugins([
      (api) => api.hook('onTurnEnd', () => void calls.push('void')),
      (api) =>
        api.hook('onTurnEnd', () => {
          calls.push('false')
          return { stop: false, reason: '仅记录' }
        }),
      (api) =>
        api.hook('onTurnEnd', () => {
          calls.push('empty')
          return {}
        }),
    ])
    const decision = await hooks.onTurnEnd?.(ctx, turnEndEvent({ finishReason: 'stop' }))
    expect(decision).toBeUndefined()
    expect(calls).toEqual(['void', 'false', 'empty']) // 无 stop → 无短路
  })

  it('void 与决策混注册：void 不干预，直到遇到首个 stop 决策才短路', async () => {
    const calls: string[] = []
    const hooks = assemblePlugins([
      (api) => api.hook('onTurnEnd', () => void calls.push('v1')), // void
      (api) =>
        api.hook('onTurnEnd', () => {
          calls.push('v2')
          return undefined // 显式 undefined 也是不干预
        }),
      (api) =>
        api.hook('onTurnEnd', () => {
          calls.push('stop')
          return {
            stop: true,
            runStatus: 'stopped',
            reason: 'stopped',
            traceEventName: 'agent.test_stopped',
          }
        }),
      (api) => api.hook('onTurnEnd', () => void calls.push('never')),
    ])
    const decision = await hooks.onTurnEnd?.(ctx, turnEndEvent())
    expect(decision).toEqual({
      stop: true,
      runStatus: 'stopped',
      reason: 'stopped',
      traceEventName: 'agent.test_stopped',
    })
    expect(calls).toEqual(['v1', 'v2', 'stop']) // never 被短路
  })

  it('异步 onTurnEnd 也串行 await（stop 判定在 await 之后）', async () => {
    const hooks = assemblePlugins([
      (api) =>
        api.hook('onTurnEnd', async () => {
          await Promise.resolve()
          return { stop: true, runStatus: 'error', reason: 'async', traceEventName: 'agent.test_async' }
        }),
    ])
    expect(await hooks.onTurnEnd?.(ctx, turnEndEvent({ finishReason: 'stop' }))).toEqual({
      stop: true,
      runStatus: 'error',
      reason: 'async',
      traceEventName: 'agent.test_async',
    })
  })
})

describe('shouldStop —— 任一返回 true 即 true（短路）', () => {
  it('遇到首个 true 即返回，其后的 hook 不再被调', async () => {
    const calls: string[] = []
    const hooks = assemblePlugins([
      (api) =>
        api.hook('shouldStop', () => {
          calls.push('f')
          return false
        }),
      (api) =>
        api.hook('shouldStop', () => {
          calls.push('t')
          return true
        }),
      (api) =>
        api.hook('shouldStop', () => {
          calls.push('never')
          return true
        }),
    ])
    expect(await hooks.shouldStop?.(ctx)).toBe(true)
    expect(calls).toEqual(['f', 't'])
  })

  it('全部返回 false → false', async () => {
    const hooks = assemblePlugins([
      (api) => api.hook('shouldStop', () => false),
      (api) => api.hook('shouldStop', () => false),
    ])
    expect(await hooks.shouldStop?.(ctx)).toBe(false)
  })
})

describe('assemblePlugins —— 装配细节', () => {
  it('单个插件可注册多个不同槽，各自独立生效', async () => {
    const plugin: AgentPlugin = (api) => {
      api.hook('transformContext', (_c, d) => void d.messages.push(user('x')))
      api.hook('shouldStop', () => true)
    }
    const hooks = assemblePlugins([plugin])

    const draft = draftOf()
    await hooks.transformContext?.(ctx, draft)
    expect(contentsOf(draft)).toEqual(['x'])
    expect(await hooks.shouldStop?.(ctx)).toBe(true)
    expect(hooks.beforeToolCall).toBeUndefined()
  })

  it('插件返回 dispose 函数不影响装配（本 Stage 不消费 dispose）', async () => {
    const plugin: AgentPlugin = (api) => {
      api.hook('shouldStop', () => true)
      return () => {
        /* dispose，本 Stage 忽略 */
      }
    }
    const hooks = assemblePlugins([plugin])
    expect(await hooks.shouldStop?.(ctx)).toBe(true)
  })

  it('注册序 = 插件数组序，然后是插件内 hook() 调用序', async () => {
    const order: string[] = []
    const p1: AgentPlugin = (api) => {
      api.hook('onTurnEnd', () => void order.push('p1-a'))
      api.hook('onTurnEnd', () => void order.push('p1-b'))
    }
    const p2: AgentPlugin = (api) => api.hook('onTurnEnd', () => void order.push('p2'))

    const hooks = assemblePlugins([p1, p2])
    await hooks.onTurnEnd?.(ctx, turnEndEvent())
    expect(order).toEqual(['p1-a', 'p1-b', 'p2'])
  })
})

describe('registerTool —— 收集插件注册的工具（PX2），不碰任何全局 registry', () => {
  it('无插件注册 tool → tools 为空数组（是清单不是槽，空态用 [] 不是 undefined）', () => {
    const hooks = assemblePlugins([])
    expect(hooks.tools).toEqual([])
  })

  it('单个插件注册单个 tool → 原样出现在 tools 里', () => {
    const tool = fakeTool('t1')
    const hooks = assemblePlugins([(api) => api.registerTool(tool)])
    expect(hooks.tools).toEqual([tool])
  })

  it('多个插件各自 registerTool，按「插件数组序 → 插件内调用序」合并进同一个 tools 数组', () => {
    const a1 = fakeTool('a1')
    const a2 = fakeTool('a2')
    const b1 = fakeTool('b1')
    const pluginA: AgentPlugin = (api) => {
      api.registerTool(a1)
      api.registerTool(a2)
    }
    const pluginB: AgentPlugin = (api) => api.registerTool(b1)

    const hooks = assemblePlugins([pluginA, pluginB])
    expect(hooks.tools).toEqual([a1, a2, b1])
  })

  it('registerTool 与 hook 互不干扰——同一插件里两者独立生效', async () => {
    const tool = fakeTool('mix')
    const hooks = assemblePlugins([
      (api) => {
        api.registerTool(tool)
        api.hook('shouldStop', () => true)
      },
    ])
    expect(hooks.tools).toEqual([tool])
    expect(await hooks.shouldStop?.(ctx)).toBe(true)
    expect(hooks.beforeToolCall).toBeUndefined() // 没人注册，不受 registerTool 影响
  })
})

describe('subscribe / bindSubscriptions —— 装配期只记意向，真订阅推迟到 bind（PX5）', () => {
  it('bindSubscriptions(store) 之前不碰 store.sub；调用后为每条收集到的意向各调一次', () => {
    const { store, subSpy } = watchSub(createStore())

    const hooks = assemblePlugins([
      (api) => api.subscribe(runAtom, vi.fn()),
      (api) => api.subscribe(itemsAtom, vi.fn()),
    ])
    // 断言时机：assemblePlugins 的返回值上此刻还没人调 bindSubscriptions —— 装配阶段压根拿不到
    // store（函数签名里没有这个参数），store.sub 自然一次都没被调过。
    expect(subSpy).not.toHaveBeenCalled()

    hooks.bindSubscriptions(store)
    expect(subSpy).toHaveBeenCalledTimes(2) // 两条 subscribe 意向，各绑定一次
  })

  it('bind 之前的 atom 变化不会补发给 fn（订阅只对之后的变化生效，无初值重放）', () => {
    const store = createStore()
    store.setter(runAtom, { runId: 'r0', status: 'running' }) // bind 前先变一次
    const fn = vi.fn()

    const hooks = assemblePlugins([(api) => api.subscribe(runAtom, fn)])
    hooks.bindSubscriptions(store)
    expect(fn).not.toHaveBeenCalled()

    store.setter(runAtom, { runId: 'r0', status: 'done' })
    expect(fn).toHaveBeenCalledTimes(1)
    expect(fn).toHaveBeenCalledWith({ runId: 'r0', status: 'done' })
  })

  it('atom 每次变化都现取最新值喂给 fn（不是 bind 时的旧快照）', () => {
    const store = createStore()
    const seen: unknown[] = []
    const hooks = assemblePlugins([(api) => api.subscribe(runAtom, (v) => seen.push(v))])
    hooks.bindSubscriptions(store)

    store.setter(runAtom, { runId: 'r1', status: 'running' })
    store.setter(runAtom, { runId: 'r1', status: 'done' })

    expect(seen).toEqual([
      { runId: 'r1', status: 'running' },
      { runId: 'r1', status: 'done' },
    ])
  })

  it('多个 subscribe（同一 atom 两次 + 另一个 atom）各自独立触发，互不覆盖', () => {
    const store = createStore()
    const runSeen: unknown[] = []
    const itemsSeen: unknown[] = []
    const hooks = assemblePlugins([
      (api) => api.subscribe(runAtom, (v) => runSeen.push(v)),
      (api) => api.subscribe(runAtom, (v) => runSeen.push(v)), // 同一 atom 两次订阅
      (api) => api.subscribe(itemsAtom, (v) => itemsSeen.push(v)),
    ])
    hooks.bindSubscriptions(store)

    store.setter(runAtom, { runId: 'r1', status: 'running' })
    expect(runSeen).toEqual([
      { runId: 'r1', status: 'running' },
      { runId: 'r1', status: 'running' },
    ]) // 两条订阅各触发一次
    expect(itemsSeen).toEqual([]) // 没碰 itemsAtom，不受影响

    store.setter(itemsAtom, [fakeItem('i1', 'hi')])
    expect(itemsSeen).toEqual([[fakeItem('i1', 'hi')]])
  })

  it('bindSubscriptions 返回的 dispose 能反订阅全部——dispose 后 atom 变化不再触发', () => {
    const store = createStore()
    const fn = vi.fn()
    const hooks = assemblePlugins([(api) => api.subscribe(runAtom, fn)])
    const dispose = hooks.bindSubscriptions(store)

    store.setter(runAtom, { runId: 'r1', status: 'running' })
    expect(fn).toHaveBeenCalledTimes(1)

    dispose()
    store.setter(runAtom, { runId: 'r1', status: 'done' })
    expect(fn).toHaveBeenCalledTimes(1) // dispose 之后不再增加
  })

  it('无插件 subscribe → bindSubscriptions 返回的 dispose 是安全 no-op', () => {
    const store = createStore()
    const hooks = assemblePlugins([])
    const dispose = hooks.bindSubscriptions(store)
    expect(() => dispose()).not.toThrow()
  })
})

describe('多插件混注册 —— hook / subscribe / registerTool 互不干扰', () => {
  it('三个插件各只注册一种能力，三者独立生效、互不覆盖', async () => {
    const store = createStore()
    const tool = fakeTool('only-tool')
    const seen: unknown[] = []

    const hookOnlyPlugin: AgentPlugin = (api) => api.hook('shouldStop', () => true)
    const subscribeOnlyPlugin: AgentPlugin = (api) => api.subscribe(runAtom, (v) => seen.push(v))
    const toolOnlyPlugin: AgentPlugin = (api) => api.registerTool(tool)

    const hooks = assemblePlugins([hookOnlyPlugin, subscribeOnlyPlugin, toolOnlyPlugin])
    hooks.bindSubscriptions(store)

    expect(hooks.tools).toEqual([tool])
    expect(await hooks.shouldStop?.(ctx)).toBe(true)
    expect(hooks.beforeToolCall).toBeUndefined() // 没人注册

    store.setter(runAtom, { runId: 'r1', status: 'running' })
    expect(seen).toEqual([{ runId: 'r1', status: 'running' }])
  })

  it('单个插件同时注册 hook + subscribe + tool，三者独立生效', async () => {
    const store = createStore()
    const tool = fakeTool('bundle')
    const seen: unknown[] = []

    const bundlePlugin: AgentPlugin = (api) => {
      api.hook('shouldStop', () => true)
      api.registerTool(tool)
      api.subscribe(runAtom, (v) => seen.push(v))
    }

    const hooks = assemblePlugins([bundlePlugin])
    hooks.bindSubscriptions(store)

    expect(hooks.tools).toEqual([tool])
    expect(await hooks.shouldStop?.(ctx)).toBe(true)

    store.setter(runAtom, { runId: 'r9', status: 'done' })
    expect(seen).toEqual([{ runId: 'r9', status: 'done' }])
  })

  it('多插件分别注册 hook + subscribe + tool，装配序不影响各自独立生效', async () => {
    const store = createStore()
    const toolA = fakeTool('order-a')
    const toolB = fakeTool('order-b')
    const order: string[] = []

    const hooks = assemblePlugins([
      (api) => api.registerTool(toolA),
      (api) => api.hook('onTurnEnd', () => void order.push('turn-end')),
      (api) => api.subscribe(runAtom, () => order.push('subscribed')),
      (api) => api.registerTool(toolB),
    ])
    hooks.bindSubscriptions(store)

    expect(hooks.tools).toEqual([toolA, toolB])
    await hooks.onTurnEnd?.(ctx, turnEndEvent({ finishReason: 'stop' }))
    store.setter(runAtom, { runId: 'r1', status: 'running' })

    expect(order).toEqual(['turn-end', 'subscribed'])
  })
})
