import { createStore } from '@einfach/core'
import { describe, expect, it, vi } from 'vitest'
import { runAtom } from '../../state/sessionAtoms'
import { createToolRegistry } from '../../tools/toolRegistry'
import type { Tool } from '../../tools/types'
import { createCoreInstance } from './coreInstance'
import { createPluginHost, type CorePlugin } from './pluginHost'

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
})
