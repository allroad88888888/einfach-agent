import { createStore } from '@einfach/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { createPluginSettingsService } from './service'
import {
  pluginHydrationAtom,
  pluginOperationsAtom,
  pluginRowsAtom,
  pluginSettingsCapabilitiesAtom,
} from './state'
import { createMemoryPluginToggleStorage } from './toggleStorage'
import { FakePluginSettingsProvider, loadedPlugin } from './testFixtures'
import type { PluginRow } from './types'

function rowByDir(rows: readonly PluginRow[], dirName: string): PluginRow | undefined {
  return rows.find((row) => row.dirName === dirName)
}

describe('createPluginSettingsService', () => {
  let store: ReturnType<typeof createStore>

  beforeEach(() => {
    store = createStore()
  })

  it('derives enabled/incompatible/failed/invalid statuses from a PluginLoadResult', async () => {
    const provider = new FakePluginSettingsProvider({
      plugins: [
        loadedPlugin({ dirName: 'good', id: 'com.example.good', name: 'Good', version: '1.0.0', status: 'enabled', dispose: () => {} }),
        loadedPlugin({ dirName: 'old-api', id: 'com.example.old', name: 'Old', version: '1.0.0', status: 'incompatible', diagnostics: ['old-api: apiVersion 不兼容'] }),
        loadedPlugin({ dirName: 'broken', id: 'com.example.broken', name: 'Broken', version: '1.0.0', status: 'failed', diagnostics: ['broken: 安装失败'] }),
        // manifest 从未解析成功：没有 id/name/version，只有 dirName——对应面板的 'invalid'。
        loadedPlugin({ dirName: 'bad-manifest', status: 'failed', diagnostics: ['bad-manifest: manifest 无效，未加载'] }),
      ],
    })
    const service = createPluginSettingsService({
      store,
      provider,
      toggleStorage: createMemoryPluginToggleStorage(),
    })

    await service.hydrate()

    expect(store.getter(pluginHydrationAtom)).toEqual({ status: 'ready' })
    expect(store.getter(pluginSettingsCapabilitiesAtom)).toEqual({ supported: true })
    const rows = store.getter(pluginRowsAtom)
    expect(rowByDir(rows, 'good')).toMatchObject({ status: 'enabled', toggleable: true })
    expect(rowByDir(rows, 'old-api')).toMatchObject({ status: 'incompatible', toggleable: false })
    expect(rowByDir(rows, 'broken')).toMatchObject({ status: 'failed', toggleable: false })
    const invalidRow = rowByDir(rows, 'bad-manifest')
    expect(invalidRow).toMatchObject({ status: 'invalid', toggleable: false })
    expect(invalidRow?.id).toBeUndefined()
  })

  it('reports the withheld-tools count on the row (per-tool checkboxes: service.tools.test.ts)', async () => {
    const provider = new FakePluginSettingsProvider({
      plugins: [
        loadedPlugin({
          dirName: 'with-tools',
          id: 'com.example.tools',
          name: 'Tools',
          version: '1.0.0',
          status: 'enabled',
          withheldTools: ['plugin_tool_a', 'plugin_tool_b'],
          dispose: () => {},
        }),
      ],
    })
    const service = createPluginSettingsService({
      store,
      provider,
      toggleStorage: createMemoryPluginToggleStorage(),
    })

    await service.hydrate()

    const row = rowByDir(store.getter(pluginRowsAtom), 'with-tools')
    expect(row?.withheldToolsCount).toBe(2)
  })

  it('honors a previously persisted disable by disposing the freshly loaded plugin on hydrate', async () => {
    const provider = new FakePluginSettingsProvider({
      plugins: [
        loadedPlugin({ dirName: 'was-off', id: 'com.example.off', name: 'Off', version: '1.0.0', status: 'enabled', dispose: () => {} }),
      ],
    })
    const toggleStorage = createMemoryPluginToggleStorage({ disabled: { 'com.example.off': true } })
    const service = createPluginSettingsService({ store, provider, toggleStorage })

    await service.hydrate()

    expect(provider.disposeCalls).toEqual(['was-off'])
    const row = rowByDir(store.getter(pluginRowsAtom), 'was-off')
    expect(row).toMatchObject({ status: 'disabled', toggleable: true })
  })

  it('disable() calls dispose and persists the toggle; enable() re-installs via the provider', async () => {
    const provider = new FakePluginSettingsProvider({
      plugins: [
        loadedPlugin({ dirName: 'toggle-me', id: 'com.example.toggle', name: 'Toggle', version: '1.0.0', status: 'enabled', dispose: () => {} }),
      ],
    })
    const toggleStorage = createMemoryPluginToggleStorage()
    const service = createPluginSettingsService({ store, provider, toggleStorage })
    await service.hydrate()

    await service.disable('toggle-me')
    expect(provider.disposeCalls).toEqual(['toggle-me'])
    expect(toggleStorage.load()).toEqual({ disabled: { 'com.example.toggle': true }, tools: {} })
    expect(rowByDir(store.getter(pluginRowsAtom), 'toggle-me')?.status).toBe('disabled')
    expect(store.getter(pluginOperationsAtom)).toEqual({})

    await service.enable('toggle-me')
    expect(provider.enableCalls).toEqual(['toggle-me'])
    expect(toggleStorage.load()).toEqual({ disabled: {}, tools: {} })
    expect(rowByDir(store.getter(pluginRowsAtom), 'toggle-me')?.status).toBe('enabled')
  })

  it('degrades to failed when an ill-behaved provider throws from enable()', async () => {
    const provider = new FakePluginSettingsProvider({
      plugins: [
        loadedPlugin({ dirName: 'flaky', id: 'com.example.flaky', name: 'Flaky', version: '1.0.0', status: 'enabled', dispose: () => {} }),
      ],
    })
    provider.enable = async () => {
      throw new Error('boom')
    }
    const toggleStorage = createMemoryPluginToggleStorage({ disabled: { 'com.example.flaky': true } })
    const service = createPluginSettingsService({ store, provider, toggleStorage })
    await service.hydrate()

    await service.enable('flaky')
    const row = rowByDir(store.getter(pluginRowsAtom), 'flaky')
    expect(row?.status).toBe('failed')
    expect(row?.diagnostics.join('\n')).toContain('启用失败')
  })

  it('reports an unsupported host as empty rows without calling load()', async () => {
    let loadCalled = false
    const provider = {
      capabilities: { supported: false },
      load: async () => {
        loadCalled = true
        return { plugins: [], unverified: [] }
      },
      enable: async () => {
        throw new Error('not reachable')
      },
    }
    const service = createPluginSettingsService({
      store,
      provider,
      toggleStorage: createMemoryPluginToggleStorage(),
    })

    await service.hydrate()

    expect(loadCalled).toBe(false)
    expect(store.getter(pluginSettingsCapabilitiesAtom)).toEqual({ supported: false })
    expect(store.getter(pluginRowsAtom)).toEqual([])
    expect(store.getter(pluginHydrationAtom)).toEqual({ status: 'ready' })
  })

  it('reports a load() failure as a hydration error', async () => {
    const provider = {
      capabilities: { supported: true },
      load: async () => {
        throw new Error('scan failed')
      },
      enable: async () => {
        throw new Error('not reachable')
      },
    }
    const service = createPluginSettingsService({
      store,
      provider,
      toggleStorage: createMemoryPluginToggleStorage(),
    })

    await service.hydrate()

    expect(store.getter(pluginHydrationAtom)).toEqual({ status: 'error', error: 'scan failed' })
  })

  it('dispose() tears down every currently installed plugin', async () => {
    const provider = new FakePluginSettingsProvider({
      plugins: [
        loadedPlugin({ dirName: 'a', id: 'com.example.a', name: 'A', version: '1.0.0', status: 'enabled', dispose: () => {} }),
        loadedPlugin({ dirName: 'b', id: 'com.example.b', name: 'B', version: '1.0.0', status: 'enabled', dispose: () => {} }),
      ],
    })
    const service = createPluginSettingsService({
      store,
      provider,
      toggleStorage: createMemoryPluginToggleStorage(),
    })
    await service.hydrate()

    service.dispose()

    expect(provider.disposeCalls.sort()).toEqual(['a', 'b'])
  })
})
