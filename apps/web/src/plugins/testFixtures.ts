// apps/web/src/plugins/testFixtures.ts —— 插件设置的测试替身
// ---------------------------------------------------------------------------
// 只被测试 import。桌面真实 provider（扫描 + importModule + plugin host）是 P10 的卡；
// 在此之前，service/组件测试都靠这里的内存 fixture 驱动，对齐 mcp/service.fixtures.ts
// 的角色划分。

import type {
  LoadedPlugin,
  PluginLoadResult,
  PluginSettingsCapabilities,
  PluginSettingsProvider,
  PluginToolGate,
} from './types'

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
 * 内存版 PluginSettingsProvider。
 *
 * load()/enable() 都按传入的 isToolEnabled 重算 grantedTools/withheldTools，模仿 P4 闸门
 * （pluginToolGate.ts）在注册期的判定：构造时给的 `withheldTools` 视为该插件声明的
 * 模型可见工具名单，`grantedTools` 视为不受闸门管的到点工具，恒放行。没有这一步，
 * 测试就只能断言"重装被调用过"，断言不了"勾选真的让工具进/出了清单"。
 *
 * 同时记录每次 dispose/enable 调用，供测试断言重装路径确实走了。
 */
export class FakePluginSettingsProvider implements PluginSettingsProvider {
  readonly capabilities: PluginSettingsCapabilities
  readonly disposeCalls: string[] = []
  readonly enableCalls: string[] = []
  private readonly plugins: Map<string, LoadedPlugin>
  /** dirName → 声明的模型可见工具名单（构造时的 withheldTools），闸门重算的输入。 */
  private readonly declaredTools = new Map<string, readonly string[]>()
  /** dirName → 恒放行的工具名单（构造时的 grantedTools）。 */
  private readonly alwaysGranted = new Map<string, readonly string[]>()

  constructor(options: FakePluginSettingsProviderOptions = {}) {
    this.plugins = new Map()
    this.capabilities = options.capabilities ?? { supported: true }
    for (const item of options.plugins ?? []) {
      this.declaredTools.set(item.dirName, [...item.withheldTools])
      this.alwaysGranted.set(item.dirName, [...item.grantedTools])
      this.plugins.set(item.dirName, this.withTrackedDispose(item))
    }
  }

  async load(isToolEnabled: PluginToolGate): Promise<PluginLoadResult> {
    const plugins = [...this.plugins.values()].map((item) => this.applyGate(item, isToolEnabled))
    for (const item of plugins) this.plugins.set(item.dirName, item)
    return { plugins, unverified: [] }
  }

  async enable(dirName: string, isToolEnabled: PluginToolGate): Promise<LoadedPlugin> {
    this.enableCalls.push(dirName)
    const existing = this.plugins.get(dirName)
    if (!existing) throw new Error(`unknown plugin dir: ${dirName}`)
    const reinstalled = this.withTrackedDispose(
      this.applyGate({ ...existing, status: 'enabled', dispose: () => {} }, isToolEnabled),
    )
    this.plugins.set(dirName, reinstalled)
    return reinstalled
  }

  private applyGate(item: LoadedPlugin, isToolEnabled: PluginToolGate): LoadedPlugin {
    const declared = this.declaredTools.get(item.dirName) ?? []
    const pluginId = item.id
    const allowed = (name: string) => pluginId !== undefined && isToolEnabled(pluginId, name)
    return {
      ...item,
      grantedTools: [...(this.alwaysGranted.get(item.dirName) ?? []), ...declared.filter(allowed)],
      withheldTools: declared.filter((name) => !allowed(name)),
    }
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
