import { describe, expect, it } from 'vitest'

import type { CoreCtx } from './coreCtx'
import { assemblePlugins } from './pluginApi'

const ctx = { sessionId: 's', runId: 'r' } as unknown as CoreCtx

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
    expect(calls).toEqual(['A', 'B'])
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
          return { a: 1, shared: 'A' }
        }),
      (api) =>
        api.hook('afterToolCall', (_c, ev) => {
          seen.push(ev.result)
          return { b: 2, shared: 'B', a: undefined }
        }),
    ])

    const out = await hooks.afterToolCall?.(ctx, { toolCall: 't', result: { orig: 0 } })
    expect(out).toEqual({ orig: 0, a: 1, shared: 'B', b: 2 })
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
    expect(original).toEqual({ a: 1 })
  })
})
