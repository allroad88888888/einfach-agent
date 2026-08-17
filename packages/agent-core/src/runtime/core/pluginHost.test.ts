import { createHistory, createStore } from '@einfach/core'
import { describe, expect, it, vi } from 'vitest'
import { runAtom } from '../../state/sessionAtoms'
import { createToolRegistry } from '../../tools/toolRegistry'
import type { Tool } from '../../tools/types'
import { makeCoreCtx } from './coreCtx'
import { createCoreInstance } from './coreInstance'
import { createPluginHost, type CorePlugin } from './pluginHost'
import { definePlugin } from './pluginContracts'
import type { PluginApi } from './pluginApi'
import { createSessionHistory } from '../../state/sessionHistory'

function traceCtx(store: ReturnType<typeof createStore>, traceEvent = vi.fn()) {
  return makeCoreCtx({ history: createSessionHistory(store),
    sessionId: 's', runId: 'r', signal: new AbortController().signal, store, root: store, traceEvent,
  })
}

function makeTool(name: string): Tool {
  return {
    name,
    runtime: 'internal',
    skill: { description: name, content: name },
    inputSchema: { type: 'object', properties: {} },
    execute: async () => ({ ok: true }),
  }
}

function trackingPlugin(name: string, seen: unknown[], dispose: () => void): CorePlugin {
  return {
    install: (api) => api.registerTool(makeTool(name)),
    activate: (api) => {
      api.subscribe(runAtom, (value) => seen.push(value))
      return dispose
    },
  }
}

describe('pluginHost', () => {
  it('keeps Core-owned tools and run subscriptions isolated', async () => {
    const seenA: unknown[] = []
    const seenB: unknown[] = []
    const disposeA = vi.fn()
    const disposeB = vi.fn()
    const a = createCoreInstance({ plugins: [trackingPlugin('tool-a', seenA, disposeA)] })
    const b = createCoreInstance({ plugins: [trackingPlugin('tool-b', seenB, disposeB)] })
    const storeA = a.getSessionStore('shared').store
    const storeB = b.getSessionStore('shared').store
    const runA = await a.plugins.activateRun(storeA)
    const runB = await b.plugins.activateRun(storeB)

    expect(a.tools.has('tool-a')).toBe(true)
    expect(a.tools.has('tool-b')).toBe(false)
    expect(b.tools.has('tool-a')).toBe(false)
    expect(b.tools.has('tool-b')).toBe(true)

    storeA.setter(runAtom, { runId: 'a', status: 'running' })
    expect(seenA).toEqual([{ runId: 'a', status: 'running' }])
    expect(seenB).toEqual([])

    runA.dispose()
    storeA.setter(runAtom, { runId: 'a', status: 'done' })
    storeB.setter(runAtom, { runId: 'b', status: 'running' })
    expect(seenA).toEqual([{ runId: 'a', status: 'running' }])
    expect(seenB).toEqual([{ runId: 'b', status: 'running' }])
    expect(disposeA).toHaveBeenCalledTimes(1)

    runB.dispose()
    a.plugins.dispose()
    b.plugins.dispose()
    expect(a.tools.has('tool-a')).toBe(false)
    expect(b.tools.has('tool-b')).toBe(false)
    expect(disposeB).toHaveBeenCalledTimes(1)
  })

  it('rejects all plugin tool registrations atomically on a name conflict', () => {
    const registry = createToolRegistry()
    registry.register(makeTool('host-tool'))
    const installerDispose = vi.fn()

    expect(() => createPluginHost(registry, [
      {
        install(api) {
          api.registerTool(makeTool('new-tool'))
          return installerDispose
        },
      },
      { install: (api) => api.registerTool(makeTool('host-tool')) },
    ])).toThrow('plugin tool name conflict: host-tool')

    expect(registry.has('host-tool')).toBe(true)
    expect(registry.has('new-tool')).toBe(false)
    expect(installerDispose).toHaveBeenCalledTimes(1)
  })

  it('cleans active runs before unregistering owned tools during host unload', async () => {
    const registry = createToolRegistry()
    const runDispose = vi.fn()
    const installDispose = vi.fn()
    const host = createPluginHost(registry, [{
      install(api) {
        api.registerTool(makeTool('owned-tool'))
        return installDispose
      },
      activate: () => runDispose,
    }])
    await host.activateRun(createStore())

    host.dispose()
    host.dispose()

    expect(runDispose).toHaveBeenCalledTimes(1)
    expect(installDispose).toHaveBeenCalledTimes(1)
    expect(registry.has('owned-tool')).toBe(false)
  })

  it('releases already activated plugins when a later activation fails', async () => {
    const release = vi.fn()
    const host = createPluginHost(createToolRegistry(), [
      { activate: () => release },
      { activate: () => { throw new Error('activation failed') } },
    ])

    await expect(host.activateRun(createStore())).rejects.toThrow('activation failed')
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('limits public stop commands to the current active run and mutable run statuses', async () => {
    const calls: boolean[] = []
    const stopCurrentRun = vi.fn(() => true)
    const host = createPluginHost(createToolRegistry(), [definePlugin({
      activate(api) {
        api.observeRun(() => calls.push(api.commands.stopCurrentRun()))
      },
    })])
    const store = createStore()
    host.bindCommandFacade({ stopCurrentRun })

    store.setter(runAtom, { runId: 'run-1', status: 'waiting_confirmation' })
    const waiting = await host.activateRun(store, { runId: 'run-1', isActiveSession: () => true })
    waiting.dispose()

    store.setter(runAtom, { runId: 'other-run', status: 'running' })
    const stale = await host.activateRun(store, { runId: 'run-1', isActiveSession: () => true })
    stale.dispose()

    store.setter(runAtom, { runId: 'run-1', status: 'running' })
    const inactive = await host.activateRun(store, { runId: 'run-1', isActiveSession: () => false })
    inactive.dispose()

    const active = await host.activateRun(store, { runId: 'run-1', isActiveSession: () => true })
    active.dispose()

    expect(calls).toEqual([false, false, false, true])
    expect(stopCurrentRun).toHaveBeenCalledTimes(1)
    host.dispose()
  })

  describe('P7 · 动态安装插件的熔断', () => {
    const identity = { id: 'acme.dynamic', version: '1.0.0' }
    const failingDynamicPlugin = (): CorePlugin => ({
      install: (api) => api.registerTool(makeTool('dynamic-tool')),
      activate: (api) => {
        api.hook('beforeToolCall', () => {
          throw new Error('dynamic boom')
        })
      },
    })

    it('连续 3 次 hook 失败自动卸载动态插件的工具，并发带 plugin.id 的自动停用事件', async () => {
      const registry = createToolRegistry()
      const host = createPluginHost(registry, [])
      host.installPlugin(failingDynamicPlugin(), identity)
      const store = createStore()
      const run = await host.activateRun(store)
      const traceEvent = vi.fn()
      const ctx = traceCtx(store, traceEvent)
      const ev = { callId: 'c1', toolName: 'dynamic-tool', args: {} }

      await expect(run.hooks.beforeToolCall?.(ctx, ev)).rejects.toThrow('dynamic boom')
      await expect(run.hooks.beforeToolCall?.(ctx, ev)).rejects.toThrow('dynamic boom')
      expect(registry.has('dynamic-tool')).toBe(true)

      await expect(run.hooks.beforeToolCall?.(ctx, ev)).rejects.toThrow('dynamic boom')
      expect(registry.has('dynamic-tool')).toBe(false)
      expect(traceEvent).toHaveBeenCalledWith('agent.plugin_auto_disabled', expect.objectContaining({
        'plugin.id': 'acme.dynamic',
        'plugin.version': '1.0.0',
      }))

      run.dispose()
      host.dispose()
    })

    it('自动停用后手动重新 installPlugin 得到全新计数——不继承之前的失败次数', async () => {
      const registry = createToolRegistry()
      const host = createPluginHost(registry, [])
      const store = createStore()
      const ev = { callId: 'c1', toolName: 'dynamic-tool', args: {} }

      host.installPlugin(failingDynamicPlugin(), identity)
      const firstRun = await host.activateRun(store)
      for (let i = 0; i < 3; i += 1) {
        await expect(firstRun.hooks.beforeToolCall?.(traceCtx(store), ev)).rejects.toThrow()
      }
      expect(registry.has('dynamic-tool')).toBe(false)
      firstRun.dispose()

      // 手动恢复（对应 P5 面板的启用动作）：同一 identity 重新 install。
      host.installPlugin(failingDynamicPlugin(), identity)
      expect(registry.has('dynamic-tool')).toBe(true)
      const secondRun = await host.activateRun(store)
      const traceEvent = vi.fn()
      const ctx = traceCtx(store, traceEvent)
      await expect(secondRun.hooks.beforeToolCall?.(ctx, ev)).rejects.toThrow()
      await expect(secondRun.hooks.beforeToolCall?.(ctx, ev)).rejects.toThrow()

      // 只失败 2 次，未达阈值 3——证明没有带着上一次安装的计数。
      expect(registry.has('dynamic-tool')).toBe(true)
      expect(traceEvent).not.toHaveBeenCalledWith('agent.plugin_auto_disabled', expect.anything())

      secondRun.dispose()
      host.dispose()
    })

    it('构造期插件是宿主源码信任域，hook 反复失败不经过熔断', async () => {
      const registry = createToolRegistry()
      const host = createPluginHost(registry, [{
        activate: (api: PluginApi) => {
          api.hook('beforeToolCall', () => {
            throw new Error('construction boom')
          })
        },
      }])
      const store = createStore()
      const run = await host.activateRun(store)
      const traceEvent = vi.fn()
      const ctx = traceCtx(store, traceEvent)
      const ev = { callId: 'c1', toolName: 'demo', args: {} }

      for (let i = 0; i < 5; i += 1) {
        await expect(run.hooks.beforeToolCall?.(ctx, ev)).rejects.toThrow('construction boom')
      }
      // 没有任何一次调用经过熔断包装——不会有 plugin_hook_failed / plugin_auto_disabled 事件。
      expect(traceEvent).not.toHaveBeenCalled()

      run.dispose()
      host.dispose()
    })
  })
})
