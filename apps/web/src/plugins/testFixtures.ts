// apps/web/src/plugins/testFixtures.ts —— 插件设置的测试替身
// ---------------------------------------------------------------------------
// 只被测试 import。桌面真实 provider（扫描 + importModule + plugin host）是 P10 的卡；
// 在此之前，service/组件测试都靠这里的内存 fixture 驱动，对齐 mcp/service.fixtures.ts
// 的角色划分。

import type { LoadedPlugin, PluginLoadResult, PluginSettingsCapabilities, PluginSettingsProvider } from './types'

/** 按需覆盖字段，快速拼一条 LoadedPlugin；未传的字段落一份"什么都没有"的默认值。 */
export function loadedPlugin(overrides: { dirName: string } & Partial<LoadedPlugin>): LoadedPlugin {
  return {
    status: 'enabled',
    diagnostics: [],
    grantedTools: [],
    withheldTools: [],
    deniedCapabilities: [],
    ...overrides,
  }
}

export interface FakePluginSettingsProviderOptions {
  capabilities?: PluginSettingsCapabilities
  plugins?: readonly LoadedPlugin[]
}

/**
 * 内存版 PluginSettingsProvider：load() 回放构造时传入的快照，enable() 把对应目录的项
 * 重置为一个新的 'enabled' 项（带全新 dispose）。同时记录每次 dispose/enable 调用，
 * 供测试断言"停用真的调了 dispose、启用真的重走了一次安装"。
 */
export class FakePluginSettingsProvider implements PluginSettingsProvider {
  readonly capabilities: PluginSettingsCapabilities
  readonly disposeCalls: string[] = []
  readonly enableCalls: string[] = []
  private readonly plugins: Map<string, LoadedPlugin>

  constructor(options: FakePluginSettingsProviderOptions = {}) {
    this.capabilities = options.capabilities ?? { supported: true }
    this.plugins = new Map(
      (options.plugins ?? []).map((item) => [item.dirName, this.withTrackedDispose(item)]),
    )
  }

  async load(): Promise<PluginLoadResult> {
    return { plugins: [...this.plugins.values()], unverified: [] }
  }

  async enable(dirName: string): Promise<LoadedPlugin> {
    this.enableCalls.push(dirName)
    const existing = this.plugins.get(dirName)
    if (!existing) throw new Error(`unknown plugin dir: ${dirName}`)
    const reinstalled = this.withTrackedDispose({
      ...existing,
      status: 'enabled',
      dispose: () => {},
    })
    this.plugins.set(dirName, reinstalled)
    return reinstalled
  }

  private withTrackedDispose(item: LoadedPlugin): LoadedPlugin {
    if (!item.dispose) return item
    const originalDispose = item.dispose
    return {
      ...item,
      dispose: () => {
        this.disposeCalls.push(item.dirName)
        originalDispose()
      },
    }
  }
}
