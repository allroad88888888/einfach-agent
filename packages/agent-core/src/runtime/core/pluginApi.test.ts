import { describe, expect, it } from 'vitest'

import type { CoreCtx } from './coreCtx'
import type { TurnEndEvent } from './loopHooks'
import { assemblePlugins, type AgentPlugin } from './pluginApi'

// 组合逻辑不读 ctx，用最小假 ctx 即可（makeCoreCtx 的接线由 coreCtx.test 覆盖）。
const ctx = { sessionId: 's', runId: 'r' } as unknown as CoreCtx

const shouldStopDecision = {
  stop: true,
  runStatus: 'stopped',
  reason: 'plugin requested stop',
  checkpoint: { kind: 'stopped' },
} as const

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

describe('shouldStop —— 首个显式停止决定胜且短路', () => {
  it('遇到首个决定即返回，其后的 hook 不再被调', async () => {
    const calls: string[] = []
    const hooks = assemblePlugins([
      (api) =>
        api.hook('shouldStop', () => {
          calls.push('f')
          return undefined
        }),
      (api) =>
        api.hook('shouldStop', () => {
          calls.push('t')
          return shouldStopDecision
        }),
      (api) =>
        api.hook('shouldStop', () => {
          calls.push('never')
          return shouldStopDecision
        }),
    ])
    expect(await hooks.shouldStop?.(ctx, turnEndEvent())).toEqual(shouldStopDecision)
    expect(calls).toEqual(['f', 't'])
  })

  it('全部继续 → undefined', async () => {
    const hooks = assemblePlugins([
      (api) => api.hook('shouldStop', () => undefined),
      (api) => api.hook('shouldStop', () => undefined),
    ])
    expect(await hooks.shouldStop?.(ctx, turnEndEvent())).toBeUndefined()
  })
})

describe('assemblePlugins —— 装配细节', () => {
  it('单个插件可注册多个不同槽，各自独立生效', async () => {
    let transformed = false
    const plugin: AgentPlugin = (api) => {
      api.hook('transformContext', () => void (transformed = true))
      api.hook('shouldStop', () => shouldStopDecision)
    }
    const hooks = assemblePlugins([plugin])

    await hooks.transformContext?.(ctx, { messages: [] })
    expect(transformed).toBe(true)
    expect(await hooks.shouldStop?.(ctx, turnEndEvent())).toEqual(shouldStopDecision)
    expect(hooks.beforeToolCall).toBeUndefined()
  })

  it('插件返回 dispose 函数不影响装配（本 Stage 不消费 dispose）', async () => {
    const plugin: AgentPlugin = (api) => {
      api.hook('shouldStop', () => shouldStopDecision)
      return () => {
        /* dispose，本 Stage 忽略 */
      }
    }
    const hooks = assemblePlugins([plugin])
    expect(await hooks.shouldStop?.(ctx, turnEndEvent())).toEqual(shouldStopDecision)
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
