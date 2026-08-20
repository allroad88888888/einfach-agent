// 外部插件的 hook 面 = 仓内插件的 hook 面（F2 卡）。这里钉三件事：
// 1) 7 个槽全都注册得上、且返回值真的透传到 loop（从前 afterToolCall 的返回值被写死成 undefined）；
// 2) 槽名清单与 LoopHooks 逐字相等——外部面再缩水会当场红；
// 3) hook 拿到的 ctx 是受限投影：状态读写经 `state` 这个受限面给（F2b「给，读写同理」），
//    而 store / root / history 三个裸句柄仍然不给（理由见 pluginHookContracts.ts 文件头）。

import { createStore } from '@einfach/core'
import { describe, expect, it } from 'vitest'

import { itemsAtom, runAtom } from '../../state/sessionAtoms'
import { activeSessionIdAtom, sessionsAtom } from '../../state/rootStore'
import { createSessionHistory } from '../../state/sessionHistory'
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

  it('hook 拿到的 ctx 不含 store / root / history，给出的是身份、signal、isCurrent 与受限的 state', async () => {
    let received: PluginHookContext | undefined
    const hooks = assemblePlugins([(api: PluginApi) => {
      publicRunApi(api).hook('onRunStart', (ctx) => { received = ctx })
    }])
    await hooks.onRunStart?.(coreCtx())

    expect(Object.keys(received ?? {}).sort()).toEqual(['isCurrent', 'runId', 'sessionId', 'signal', 'state'])
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

/** 真句柄：root 里登记了会话、会话 store 里有当前 run —— 这样 isCurrent() 才是真的在判。 */
function liveCtx(sessionId = 's1', runId = 'r1') {
  const store = createStore()
  const root = createStore()
  root.setter(sessionsAtom, {
    [sessionId]: { id: sessionId, title: 't', settings: { vendor: 'v', model: 'm' }, createdAt: 0, updatedAt: 0 },
  })
  root.setter(activeSessionIdAtom, sessionId)
  store.setter(runAtom, { runId, status: 'running', turnId: 'turn-1' })
  const history = createSessionHistory(store)
  const ctx = makeCoreCtx({ sessionId, runId, signal: new AbortController().signal, store, root, history, traceEvent: () => {} })
  return { ctx, store, root, history }
}

describe('publicRunApi —— ctx.state（F2b 的状态读写面）', () => {
  it('外部插件经 ctx.state 读得到会话 atom 值与跨会话 root 值', async () => {
    const { ctx, store } = liveCtx()
    store.setter(itemsAtom, [{ id: 'a', createdAt: 1, item: { role: 'user', content: '你好' } }])

    let seen: { items: readonly { id: string }[]; activeSessionId: string } | undefined
    const hooks = assemblePlugins([(api: PluginApi) => {
      publicRunApi(api).hook('onRunStart', (hookCtx) => {
        seen = {
          items: hookCtx.state.readSession('items'),
          activeSessionId: hookCtx.state.readRoot('activeSessionId'),
        }
      })
    }])
    await hooks.onRunStart?.(ctx)

    expect(seen?.items.map((entry) => entry.id)).toEqual(['a'])
    expect(seen?.activeSessionId).toBe('s1')
  })

  it('外部插件经 ctx.state 写会话状态，写入进事务日志、undo 回到 prev', async () => {
    const { ctx, store, history } = liveCtx()

    const hooks = assemblePlugins([(api: PluginApi) => {
      publicRunApi(api).hook('onRunStart', (hookCtx) => {
        hookCtx.state.appendItem({ role: 'system', content: '第三方插件写的一条' })
      })
    }])
    await hooks.onRunStart?.(ctx)

    expect(store.getter(itemsAtom)).toHaveLength(1)
    expect(history.getState().entries).toHaveLength(1)
    expect(history.undo()).toBe(true)
    expect(store.getter(itemsAtom)).toEqual([])
  })

  it('run 换了人之后，插件手上那个 state 面写不进去（真 isCurrent 在判）', async () => {
    const { ctx, store } = liveCtx()
    let state: PluginHookContext['state'] | undefined
    const hooks = assemblePlugins([(api: PluginApi) => {
      publicRunApi(api).hook('onRunStart', (hookCtx) => { state = hookCtx.state })
    }])
    await hooks.onRunStart?.(ctx)

    store.setter(runAtom, { runId: 'r2', status: 'running', turnId: 'turn-2' })
    expect(state?.appendItem({ role: 'system', content: '迟到的回写' })).toBeUndefined()
    expect(store.getter(itemsAtom)).toEqual([])
  })
})
