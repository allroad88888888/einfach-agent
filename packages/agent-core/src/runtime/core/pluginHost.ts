// Core 私有插件宿主：安装期工具所有权与每次 run 的 hook/订阅生命周期。
import type { Store } from '@einfach/core'
import type { Tool } from '../../tools/types'
import type { ToolRegistry } from '../../tools/toolRegistry'
import { assemblePlugins, type AgentPlugin, type AssembledPlugins, type PluginApi } from './pluginApi'

export interface PluginInstallApi {
  registerTool(tool: Tool): void
}

/** A Core plugin separates long-lived tool registration from per-run behavior. */
export interface CorePlugin {
  install?(api: PluginInstallApi): void | (() => void)
  activate?(api: PluginApi): void | (() => void)
}

export type PluginInput = CorePlugin | AgentPlugin

export interface PluginRun {
  readonly hooks: AssembledPlugins
  dispose(): void
}

export interface PluginHost {
  activateRun(store: Store): Promise<PluginRun>
  dispose(): void
}

function adaptPlugin(plugin: PluginInput): CorePlugin {
  if (typeof plugin !== 'function') return plugin
  return {
    install(api) {
      return plugin({
        hook() {},
        registerTool: api.registerTool,
        subscribe() {},
      } as PluginApi)
    },
    activate: plugin,
  }
}

function disposeAll(disposers: readonly (() => void)[]): void {
  let firstError: unknown
  for (const disposer of [...disposers].reverse()) {
    try {
      disposer()
    } catch (error) {
      firstError ??= error
    }
  }
  if (firstError !== undefined) throw firstError
}

function installPlugins(registry: ToolRegistry, plugins: readonly CorePlugin[]): {
  tools: readonly Tool[]
  disposers: readonly (() => void)[]
} {
  const tools: Tool[] = []
  const disposers: Array<() => void> = []
  try {
    for (const plugin of plugins) {
      const dispose = plugin.install?.({ registerTool: (tool) => { tools.push(tool) } })
      if (dispose) disposers.push(dispose)
    }
    const names = new Set<string>()
    const conflict = tools.find((tool) => registry.has(tool.name) || names.has(tool.name) || !names.add(tool.name))
    if (conflict) throw new Error(`plugin tool name conflict: ${conflict.name}`)
    tools.forEach((tool) => registry.register(tool))
    return { tools, disposers }
  } catch (error) {
    try {
      disposeAll(disposers)
    } catch {
      // 保留最初的安装失败；已尽力释放此前安装期资源。
    }
    throw error
  }
}

/** Creates a host whose registrations and active runs are scoped to one Core instance. */
export function createPluginHost(registry: ToolRegistry, inputs: readonly PluginInput[] = []): PluginHost {
  const plugins = inputs.map(adaptPlugin)
  const installed = installPlugins(registry, plugins)
  const activeRuns = new Set<PluginRun>()
  let disposed = false

  return {
    async activateRun(store) {
      if (disposed) throw new Error('plugin host is disposed')
      // 内置插件延迟导入：compaction 仍兼容 rootStore/defaultCore，不能在 defaultCore 的构造期反向求值。
      const { defaultCorePlugins } = await import('./plugins/defaultPlugins')
      if (disposed) throw new Error('plugin host is disposed')
      const activePlugins = [...defaultCorePlugins, ...plugins]
      const hooks = assemblePlugins(activePlugins.flatMap((plugin) => (plugin.activate ? [plugin.activate] : [])))
      let unsubscribe: () => void
      try {
        unsubscribe = hooks.bindSubscriptions(store)
      } catch (error) {
        try { hooks.dispose() } catch { /* 保留订阅绑定失败 */ }
        throw error
      }
      let runDisposed = false
      const run: PluginRun = {
        hooks,
        dispose() {
          if (runDisposed) return
          runDisposed = true
          activeRuns.delete(run)
          let firstError: unknown
          try {
            unsubscribe()
          } catch (error) {
            firstError = error
          }
          try {
            hooks.dispose()
          } catch (error) {
            firstError ??= error
          }
          if (firstError !== undefined) throw firstError
        },
      }
      activeRuns.add(run)
      return run
    },
    dispose() {
      if (disposed) return
      disposed = true
      let firstError: unknown
      for (const run of [...activeRuns]) {
        try {
          run.dispose()
        } catch (error) {
          firstError ??= error
        }
      }
      for (const tool of installed.tools) registry.unregister(tool.name, tool)
      try {
        disposeAll(installed.disposers)
      } catch (error) {
        firstError ??= error
      }
      if (firstError !== undefined) throw firstError
    },
  }
}
