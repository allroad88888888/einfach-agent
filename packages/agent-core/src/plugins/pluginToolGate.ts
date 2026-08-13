// agent-core/plugins/pluginToolGate.ts —— 插件工具的模型可见性闸门
// ---------------------------------------------------------------------------
// 只负责一件事：把一个 branded 插件包成「注册工具要先过闸门」的等价插件。
//
// 拍板 3（docs/plugin-and-provider-issues.md「未决（已拍板）」）：插件声明的模型可见工具
// 默认不进模型清单，需在设置页逐工具勾选启用——这是唯一硬闸门。落地取最小路径：
// **默认不注册**（而不是注册成不可见）。因为 registry 的可见性是从 `callTiming` 推导的
// （tools/toolCatalog.ts 的 isModelVisibleTool），没有独立的 enabled 位；硬造一个可见性字段
// 会同时改动 registry、快照与 schema 加载三处。不注册则一行拦截即可，且卸载天然无残留。
// P6 接上勾选记录后，勾中的工具走同一条路径正常注册。
//
// 同时在这里落「注册只允许发生在 install 回调里」（蓝图第 3.2 节）：install 返回后闸门封口，
// 迟到的 registerTool 一律拒绝并记诊断。

import {
  definePlugin,
  type PluginDisposer,
  type PluginRunApi,
  type PublicPlugin,
} from '../runtime/core/pluginContracts'
import { isModelVisibleTool } from '../tools/toolCatalog'
import type { Tool } from '../tools/types'

export interface ToolGateOptions {
  /** 用于诊断文案与勾选查询的插件身份。 */
  readonly pluginId: string
  /** manifest 的 capabilities 是否申报了 `tools`；没申报却注册工具会额外记一条诊断。 */
  readonly declaresToolsCapability: boolean
  /** 勾选查询；默认全关。 */
  readonly isToolEnabled: (pluginId: string, toolName: string) => boolean
}

export interface ToolGateOutcome {
  /** 放行并交给宿主注册的工具名。 */
  readonly granted: readonly string[]
  /** 被闸门拦下的模型可见工具名。 */
  readonly withheld: readonly string[]
  readonly diagnostics: readonly string[]
}

export interface GatedPlugin {
  /** 交给 plugin host 安装的等价插件。 */
  readonly plugin: PublicPlugin
  /** install 是同步回调，故 host.installPlugin 返回后本对象即为终值。 */
  readonly outcome: ToolGateOutcome
}

/**
 * 判断一个工具注册后会不会出现在模型的发现面上。
 *
 * 直接用 isModelVisibleTool（`!callTiming`）还不够：registry 注册期会把 `origin: 'external'`
 * 工具的 callTiming 剥掉（tools/toolRegistry.ts 的 normalizedRegistrationTool），
 * 于是「external + callTiming」最终仍然是模型可见的。闸门必须按注册后的实际形态判定。
 */
export function isGatedModelVisibleTool(tool: Tool): boolean {
  return tool.origin === 'external' || isModelVisibleTool(tool)
}

/**
 * 把插件包成过闸门的等价插件。activate（hook / 受限命令 / 订阅）原样透传——
 * 目录即信任（拍板 1）只对 hook 与 renderer 面成立，工具面才是硬闸门。
 */
export function gatePluginTools(source: PublicPlugin, options: ToolGateOptions): GatedPlugin {
  const granted: string[] = []
  const withheld: string[] = []
  const diagnostics: string[] = []
  let sealed = false
  let sawUndeclaredTool = false

  const plugin = definePlugin({
    install(api) {
      let disposer: void | PluginDisposer
      try {
        disposer = source.install?.({
          registerTool(tool) {
            if (sealed) {
              // install 已返回：这条注册来自 top-level 或异步回调，两者都让「加载」与「启用」
              // 无法分离（蓝图第 3.2 节），一律拒绝。
              diagnostics.push(
                `${options.pluginId}: 工具 ${tool.name} 在 install 回调返回后才注册，已拒绝——注册只允许发生在 install 回调里`,
              )
              return
            }
            if (!options.declaresToolsCapability && !sawUndeclaredTool) {
              sawUndeclaredTool = true
              diagnostics.push(
                `${options.pluginId}: manifest 未申报 \`tools\` 能力却注册了工具，模型可见工具按默认关处理`,
              )
            }
            if (isGatedModelVisibleTool(tool) && !options.isToolEnabled(options.pluginId, tool.name)) {
              withheld.push(tool.name)
              return
            }
            granted.push(tool.name)
            api.registerTool(tool)
          },
        })
      } finally {
        sealed = true
      }
      return disposer
    },
    // 只在原插件真有 activate 时才带上这个键：否则会给插件凭空补出一个 activate，
    // plugin host 会把它当成有 hook 的插件送进每次 run 的装配。
    ...(source.activate
      ? { activate: (api: PluginRunApi) => source.activate?.(api) }
      : {}),
  })

  return { plugin, outcome: { granted, withheld, diagnostics } }
}

/** 闸门拦下工具时给设置页的一条汇总诊断；无拦截则不产出。 */
export function withheldToolsDiagnostic(pluginId: string, withheld: readonly string[]): string | undefined {
  if (withheld.length === 0) return undefined
  return `${pluginId}: ${withheld.length} 个模型可见工具默认未启用（${withheld.join('、')}），需在插件面板逐个勾选`
}
