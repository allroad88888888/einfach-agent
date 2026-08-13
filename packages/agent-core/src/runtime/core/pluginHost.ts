// Core 私有插件宿主：安装期工具所有权与每次 run 的 hook/订阅生命周期。
import type { Store } from '@einfach/core'
import { runAtom } from '../../state/sessionAtoms'
import type { Tool } from '../../tools/types'
import type { ToolRegistry } from '../../tools/toolRegistry'
import { assemblePlugins, type AgentPlugin, type AssembledPlugins, type PluginApi } from './pluginApi'
import type { PluginCommandFacade } from './pluginCommandFacade'
import { isPublicPlugin, type PluginInstallApi, type PluginRunApi, type PublicPlugin } from './pluginContracts'
import { wrapDynamicPluginActivate, type PluginIdentity } from './pluginCircuitBreaker'

export type { PluginInstallApi } from './pluginContracts'
export type { PluginIdentity } from './pluginCircuitBreaker'

/** A Core plugin separates long-lived tool registration from per-run behavior. */
export interface CorePlugin {
  install?(api: PluginInstallApi): void | (() => void)
  activate?(api: PluginApi): void | (() => void)
}

export type PluginInput = CorePlugin | AgentPlugin | PublicPlugin

export interface PluginRun {
  readonly hooks: AssembledPlugins
  dispose(): void
}

/** 一次构造后安装的句柄：dispose 撤销该插件的工具注册与安装期资源，不影响其余插件。 */
export interface PluginInstallation {
  /** 本次安装真正注册进 registry 的工具实例。 */
  readonly tools: readonly Tool[]
  dispose(): void
}

export interface PluginHost {
  bindCommandFacade(commands: PluginCommandFacade): void
  /**
   * 构造之后再装一个插件（动态加载用）：走与构造期相同的全量预检与原子拒绝，
   * 冲突时抛错且不留半装状态；成功则返回卸载句柄。
   *
   * 已在跑的 run 不受影响——activateRun 在 run 开始时取一次插件快照，
   * 新装/卸载的插件从下一个 run 起生效（docs/plugin-ecosystem-blueprint.md 第 5 节）。
   *
   * identity 是必填的动态插件身份（P7 熔断与归因）：它注册的 hook 连续失败达到
   * `PLUGIN_HOOK_FAILURE_THRESHOLD`（pluginCircuitBreaker.ts）次会自动调用本次返回句柄的
   * dispose()；构造期传入 `inputs` 的插件不经过这条路径，不受此约束。trace 里对应的 hook
   * 失败/自动停用事件都带 `plugin.id`/`plugin.version`。
   */
  installPlugin(plugin: PluginInput, identity: PluginIdentity): PluginInstallation
  activateRun(store: Store, activation?: PluginRunActivation): Promise<PluginRun>
  dispose(): void
}

interface PluginRunActivation {
  readonly runId?: string
  readonly isActiveSession?: () => boolean
}

const unavailableCommands: PluginCommandFacade = Object.freeze({ stopCurrentRun: () => false })

function publicRunApi(api: PluginApi): PluginRunApi {
  return {
    commands: api.commands,
    observeRun: api.observeRun,
    onAfterToolCall(listener) {
      api.hook('afterToolCall', async (_ctx, event) => {
        await listener(Object.freeze({
          callId: event.callId,
          toolName: event.toolName,
          args: Object.freeze({ ...event.args }),
          result: Object.freeze({ ...event.result }),
        }))
        return undefined
      })
    },
  }
}

function adaptPlugin(plugin: PluginInput): CorePlugin {
  if (isPublicPlugin(plugin)) {
    return {
      install: plugin.install,
      activate: plugin.activate ? (api) => plugin.activate?.(publicRunApi(api)) : undefined,
    }
  }
  if (typeof plugin !== 'function') return plugin
  return {
    install(api) {
      return plugin({
        commands: unavailableCommands,
        hook() {},
        registerTool: api.registerTool,
        subscribe() {},
        observeRun() {},
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
  const dynamicInstallations = new Set<PluginInstallation>()
  let disposed = false
  let boundCommands = unavailableCommands

  return {
    bindCommandFacade(commands) {
      if (disposed) throw new Error('plugin host is disposed')
      boundCommands = commands
    },
    installPlugin(plugin, identity) {
      if (disposed) throw new Error('plugin host is disposed')
      const adapted = adaptPlugin(plugin)
      // 预检失败时 installPlugins 已回滚本次安装期资源并抛出，plugins 不会被污染。
      const added = installPlugins(registry, [adapted])
      let installationDisposed = false
      // 间接引用：熔断触发时要调用这次安装的 dispose，但 installation 常量本身要等下面才建好。
      let disposeInstallation = () => {}
      // 熔断只代理动态插件的 activate（P7）；install 阶段已由上面的 installPlugins 处理，与熔断无关。
      const activate = adapted.activate
      const registered: CorePlugin = activate
        ? { ...adapted, activate: wrapDynamicPluginActivate(activate, identity, () => disposeInstallation()) }
        : adapted
      const installation: PluginInstallation = {
        tools: added.tools,
        dispose() {
          if (installationDisposed) return
          installationDisposed = true
          dynamicInstallations.delete(installation)
          const index = plugins.indexOf(registered)
          if (index >= 0) plugins.splice(index, 1)
          for (const tool of added.tools) registry.unregister(tool.name, tool)
          disposeAll(added.disposers)
        },
      }
      disposeInstallation = () => installation.dispose()
      plugins.push(registered)
      dynamicInstallations.add(installation)
      return installation
    },
    async activateRun(store, activation = {}) {
      if (disposed) throw new Error('plugin host is disposed')
      // 内置插件延迟导入：compaction 仍兼容 rootStore/defaultCore，不能在 defaultCore 的构造期反向求值。
      const { defaultCorePlugins } = await import('./plugins/defaultPlugins')
      if (disposed) throw new Error('plugin host is disposed')
      const activePlugins = [...defaultCorePlugins, ...plugins]
      const scopedCommands: PluginCommandFacade = Object.freeze({
        stopCurrentRun: () => {
          const run = store.getter(runAtom)
          if (!activation.isActiveSession?.() || !activation.runId || run?.runId !== activation.runId) return false
          if (run.status !== 'running' && run.status !== 'awaiting_tool') return false
          return boundCommands.stopCurrentRun()
        },
      })
      const hooks = assemblePlugins(
        activePlugins.flatMap((plugin) => (plugin.activate ? [plugin.activate] : [])),
        scopedCommands,
      )
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
      for (const installation of [...dynamicInstallations]) {
        try {
          installation.dispose()
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
