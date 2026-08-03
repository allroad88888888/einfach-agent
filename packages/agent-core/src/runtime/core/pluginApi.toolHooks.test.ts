import { describe, expect, it } from 'vitest'

import type { CoreCtx } from './coreCtx'
import type { CompletedToolResult, ToolResultPatch } from '../toolResultPatch'
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

    const res = await hooks.beforeToolCall?.(ctx, { callId: 'c1', toolName: 't', args: {} })
    expect(res).toEqual({ block: true, reason: 'B' })
    expect(calls).toEqual(['A', 'B'])
  })

  it('无人 block（含 block:false）→ 返回 undefined', async () => {
    const hooks = assemblePlugins([
      (api) => api.hook('beforeToolCall', () => undefined),
      (api) => api.hook('beforeToolCall', () => ({ block: false, reason: '仅记录' })),
    ])
    const res = await hooks.beforeToolCall?.(ctx, { callId: 'c1', toolName: 't', args: {} })
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
    expect(await hooks.beforeToolCall?.(ctx, { callId: 'c1', toolName: 't', args: {} })).toEqual({
      block: true,
      reason: 'async',
    })
  })
})

describe('afterToolCall —— 只合并同一结果分支的受控补丁', () => {
  it('按注册序合并 success patch，且每环看见上一环的累积结果', async () => {
    const seen: CompletedToolResult[] = []
    const hooks = assemblePlugins([
      (api) =>
        api.hook('afterToolCall', (_c, ev) => {
          seen.push(ev.result)
          return { data: { from: 'A' } }
        }),
      (api) =>
        api.hook('afterToolCall', (_c, ev) => {
          seen.push(ev.result)
          return { data: { from: 'B' } }
        }),
    ])

    const out = await hooks.afterToolCall?.(ctx, {
      callId: 'c1',
      toolName: 't',
      args: {},
      result: { ok: true, data: { from: 'tool' } },
    })
    expect(out).toEqual({ data: { from: 'B' } })
    expect(seen[0]).toEqual({ ok: true, data: { from: 'tool' } })
    expect(seen[1]).toEqual({ ok: true, data: { from: 'A' } })
  })

  it('patch 为 undefined → 保留累积结果（该 hook 不改结果）', async () => {
    const hooks = assemblePlugins([(api) => api.hook('afterToolCall', () => undefined)])
    const out = await hooks.afterToolCall?.(ctx, {
      callId: 'c1', toolName: 't', args: {}, result: { ok: true, data: { a: 1 } },
    })
    expect(out).toBeUndefined()
  })

  it('失败结果只接受 failure patch', async () => {
    const hooks = assemblePlugins([(api) => api.hook('afterToolCall', () => ({ code: 'plugin_code' }))])
    const out = await hooks.afterToolCall?.(ctx, {
      callId: 'c1', toolName: 't', args: {}, result: { ok: false, error: 'tool failed' },
    })
    expect(out).toEqual({ code: 'plugin_code' })
  })

  it('拒绝试图切换结果分支的 patch', async () => {
    const hooks = assemblePlugins([
      (api) => api.hook('afterToolCall', () => ({ ok: false } as unknown as ToolResultPatch)),
    ])

    await expect(hooks.afterToolCall?.(ctx, {
      callId: 'c1', toolName: 't', args: {}, result: { ok: true, data: 'tool result' },
    })).rejects.toThrow('patch 不能覆盖 ok 或 pause 控制字段')
  })
})
