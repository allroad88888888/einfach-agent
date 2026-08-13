// apps/web/src/plugins/service.tools.test.ts —— P6 的模型可见工具勾选闸门
// ---------------------------------------------------------------------------
// 与 service.test.ts 分开：那边覆盖插件级的加载/启停编排，这里只盯"逐工具勾选 →
// 重装 → 闸门放行/收回 → 记录持久化"这一条链路。

import { createStore } from '@einfach/core'
import { beforeEach, describe, expect, it } from 'vitest'
import { createPluginSettingsService, type PluginSettingsService } from './service'
import { pluginRowsAtom } from './state'
import { createMemoryPluginToggleStorage } from './toggleStorage'
import { FakePluginSettingsProvider, loadedPlugin } from './testFixtures'
import type { PluginRow, PluginToggleStorage } from './types'

const PLUGIN_ID = 'com.example.tools'
const DIR = 'with-tools'

function toolsPlugin(overrides: Partial<Parameters<typeof loadedPlugin>[0]> = {}) {
  return loadedPlugin({
    dirName: DIR,
    id: PLUGIN_ID,
    name: 'Tools',
    version: '1.0.0',
    status: 'enabled',
    // fixture 把 withheldTools 当作"该插件声明的模型可见工具名单"，按闸门重算放行/拦截。
    withheldTools: ['plugin_tool_a', 'plugin_tool_b'],
    dispose: () => {},
    ...overrides,
  })
}

function row(store: ReturnType<typeof createStore>): PluginRow {
  const found = store.getter(pluginRowsAtom).find((item) => item.dirName === DIR)
  if (!found) throw new Error(`row ${DIR} missing`)
  return found
}

describe('createPluginSettingsService · 模型可见工具勾选闸门', () => {
  let store: ReturnType<typeof createStore>
  let provider: FakePluginSettingsProvider
  let toggleStorage: PluginToggleStorage
  let service: PluginSettingsService

  beforeEach(() => {
    store = createStore()
    provider = new FakePluginSettingsProvider({ plugins: [toolsPlugin()] })
    toggleStorage = createMemoryPluginToggleStorage()
    service = createPluginSettingsService({ store, provider, toggleStorage })
  })

  it('默认全关：没有勾选记录时所有模型可见工具都被拦下', async () => {
    await service.hydrate()

    expect(row(store).tools).toEqual([
      { name: 'plugin_tool_a', enabled: false },
      { name: 'plugin_tool_b', enabled: false },
    ])
    expect(row(store).withheldToolsCount).toBe(2)
    const loaded = await provider.load(() => false)
    expect(loaded.plugins[0]?.grantedTools).toEqual([])
  })

  it('勾选后重装该插件，并让闸门放行这一个工具', async () => {
    await service.hydrate()
    const disposeCallsBefore = provider.disposeCalls.length

    await service.setToolEnabled(DIR, 'plugin_tool_a', true)

    // 重装 = 先卸载再经 provider.enable 装一遍，复用启停那条路径。
    expect(provider.disposeCalls.length).toBe(disposeCallsBefore + 1)
    expect(provider.enableCalls).toEqual([DIR])
    expect(row(store).tools).toEqual([
      { name: 'plugin_tool_a', enabled: true },
      { name: 'plugin_tool_b', enabled: false },
    ])
    expect(row(store).withheldToolsCount).toBe(1)
    // 勾中的工具真的进了 registry 那一侧的清单，另一个仍被拦下。
    const reloaded = await provider.load((id, name) =>
      id === PLUGIN_ID && name === 'plugin_tool_a',
    )
    expect(reloaded.plugins[0]?.grantedTools).toEqual(['plugin_tool_a'])
    expect(reloaded.plugins[0]?.withheldTools).toEqual(['plugin_tool_b'])
  })

  it('取消勾选再重装一次，把工具收回', async () => {
    await service.hydrate()
    await service.setToolEnabled(DIR, 'plugin_tool_a', true)

    await service.setToolEnabled(DIR, 'plugin_tool_a', false)

    expect(provider.enableCalls).toEqual([DIR, DIR])
    expect(row(store).tools).toEqual([
      { name: 'plugin_tool_a', enabled: false },
      { name: 'plugin_tool_b', enabled: false },
    ])
    expect(row(store).withheldToolsCount).toBe(2)
    expect(toggleStorage.load().tools).toEqual({})
  })

  it('勾选记录按用户持久化，新一轮加载直接读回并放行', async () => {
    await service.hydrate()
    await service.setToolEnabled(DIR, 'plugin_tool_b', true)

    expect(toggleStorage.load()).toEqual({
      disabled: {},
      tools: { [PLUGIN_ID]: { plugin_tool_b: true } },
    })

    // 冷启动重来一遍：新的 store/provider/service，只有存储是同一份。
    const nextStore = createStore()
    const nextProvider = new FakePluginSettingsProvider({ plugins: [toolsPlugin()] })
    const nextService = createPluginSettingsService({
      store: nextStore,
      provider: nextProvider,
      toggleStorage,
    })
    await nextService.hydrate()

    expect(row(nextStore).tools).toEqual([
      { name: 'plugin_tool_a', enabled: false },
      { name: 'plugin_tool_b', enabled: true },
    ])
    // hydrate 时就经 isToolEnabled 生效，不需要额外重装一次。
    expect(nextProvider.enableCalls).toEqual([])
  })

  it('插件处于停用态时只记录不重装，等下次启用统一生效', async () => {
    await service.hydrate()
    await service.disable(DIR)
    const enableCallsBefore = provider.enableCalls.length

    await service.setToolEnabled(DIR, 'plugin_tool_a', true)

    expect(provider.enableCalls.length).toBe(enableCallsBefore)
    expect(toggleStorage.load().tools).toEqual({ [PLUGIN_ID]: { plugin_tool_a: true } })
    expect(row(store).status).toBe('disabled')

    await service.enable(DIR)
    expect(row(store).status).toBe('enabled')
    expect(row(store).tools).toEqual([
      { name: 'plugin_tool_a', enabled: true },
      { name: 'plugin_tool_b', enabled: false },
    ])
  })

  it('重复勾同一个值不触发多余重装', async () => {
    await service.hydrate()

    await service.setToolEnabled(DIR, 'plugin_tool_a', false)

    expect(provider.enableCalls).toEqual([])
  })
})
