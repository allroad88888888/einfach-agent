// 外部插件的 hook 面 = 仓内插件的 hook 面（F2 卡）。这里钉三件事：
// 1) 7 个槽全都注册得上、且返回值真的透传到 loop（从前 afterToolCall 的返回值被写死成 undefined）；
// 2) 槽名清单与 LoopHooks 逐字相等——外部面再缩水会当场红；
// 3) hook 拿到的 ctx 是受限投影：没有 store / root / history（信任裁决没有放开写入面，
//    理由见 pluginHookContracts.ts 文件头）。

import { describe, expect, it } from 'vitest'

import { makeCoreCtx, type CoreCtx } from './coreCtx'
import type { LoopHooks } from './loopHooks'
import { assemblePlugins, type PluginApi } from './pluginApi'
import type { PluginHookContext } from './pluginHookContracts'
import { publicRunApi } from './publicRunApi'

const SLOTS: Array<keyof LoopHooks> = [
  'onRunStart', 'transformContext', 'prepareRequest',
  'beforeToolCall', 'afterToolCall', 'onTurnEnd', 'shouldStop',
]

const turnEvent = { finishReason: null, toolCalls: [], assistantHasContent: false, msg: undefined, hasStreamedItem: false }

function coreCtx(): CoreCtx {
  const store = { getter: () => undefined, setter: () => {}, sub: () => () => {} }
  return makeCoreCtx({
    sessionId: 's1',
    runId: 'r1',
    signal: new AbortController().signal,
    store: store as unknown as CoreCtx['store'],
    root: store as unknown as CoreCtx['root'],
    history: {} as CoreCtx['history'],
    traceEvent: () => {},
  })
}

describe('publicRunApi —— 外部插件的 7 个槽', () => {
  it('每个槽都注册得上，且 loop 侧真的看得到它们', async () => {
    const seen: string[] = []
    const hooks = assemblePlugins([(api: PluginApi) => {
      const pub = publicRunApi(api)
      for (const slot of SLOTS) {
        pub.hook(slot, ((): undefined => { seen.push(slot); return undefined }) as never)
      }
    }])

    expect(SLOTS.filter((slot) => hooks[slot] !== undefined)).toEqual(SLOTS)

    const ctx = coreCtx()
    await hooks.onRunStart?.(ctx)
    await hooks.transformContext?.(ctx, { messages: [] })
    await hooks.prepareRequest?.(ctx, { messages: [] })
    await hooks.beforeToolCall?.(ctx, { callId: 'c', toolName: 't', args: {} })
    await hooks.afterToolCall?.(ctx, { callId: 'c', toolName: 't', args: {}, result: { ok: true } })
    await hooks.onTurnEnd?.(ctx, turnEvent)
    await hooks.shouldStop?.(ctx, turnEvent)
    expect(seen).toEqual(SLOTS)
  })

  it('槽名清单与仓内 LoopHooks 完全相同（外部面缩水即红）', () => {
    const registered = new Set<string>()
    const probe: PluginApi = {
      commands: { stopCurrentRun: () => false },
      hook: (name) => { registered.add(name) },
      registerTool: () => {},
      subscribe: () => {},
      observeRun: () => {},
    }
    const pub = publicRunApi(probe)
    for (const slot of SLOTS) pub.hook(slot, (() => undefined) as never)
    expect([...registered].sort()).toEqual([...SLOTS].sort())
  })

  it('beforeToolCall 的 block 与 afterToolCall 的补丁都原样透传，不再被丢弃', async () => {
    const hooks = assemblePlugins([(api: PluginApi) => {
      const pub = publicRunApi(api)
      pub.hook('beforeToolCall', (_ctx, ev) => (ev.toolName === 'danger' ? { block: true, reason: '第三方否决' } : undefined))
      pub.hook('afterToolCall', () => ({ data: 'patched by external plugin' }))
    }])
    const ctx = coreCtx()

    expect(await hooks.beforeToolCall?.(ctx, { callId: 'c', toolName: 'danger', args: {} }))
      .toEqual({ block: true, reason: '第三方否决' })
    expect(await hooks.beforeToolCall?.(ctx, { callId: 'c', toolName: 'safe', args: {} })).toBeUndefined()
    expect(await hooks.afterToolCall?.(ctx, { callId: 'c', toolName: 'safe', args: {}, result: { ok: true } }))
      .toEqual({ data: 'patched by external plugin' })
  })

  it('transformContext 能就地改写模型这一轮看到的 messages', async () => {
    const hooks = assemblePlugins([(api: PluginApi) => {
      publicRunApi(api).hook('transformContext', (_ctx, draft) => {
        draft.messages.push({ role: 'system', content: '第三方插件注入' })
      })
    }])
    const draft = { messages: [] as Array<{ role: string; content: string }> }
    await hooks.transformContext?.(coreCtx(), draft as never)
    expect(draft.messages).toEqual([{ role: 'system', content: '第三方插件注入' }])
  })

  it('hook 拿到的 ctx 不含 store / root / history，只有身份、signal 与 isCurrent', async () => {
    let received: PluginHookContext | undefined
    const hooks = assemblePlugins([(api: PluginApi) => {
      publicRunApi(api).hook('onRunStart', (ctx) => { received = ctx })
    }])
    await hooks.onRunStart?.(coreCtx())

    expect(Object.keys(received ?? {}).sort()).toEqual(['isCurrent', 'runId', 'sessionId', 'signal'])
    const leaked = received as unknown as Record<string, unknown>
    expect(leaked.store).toBeUndefined()
    expect(leaked.root).toBeUndefined()
    expect(leaked.history).toBeUndefined()
    expect(received?.sessionId).toBe('s1')
    expect(received?.runId).toBe('r1')
    expect(typeof received?.isCurrent).toBe('function')
    expect(Object.isFrozen(received)).toBe(true)
  })
})
