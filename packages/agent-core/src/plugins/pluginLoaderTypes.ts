// agent-core/plugins/pluginLoaderTypes.ts —— 动态加载层的契约类型
// ---------------------------------------------------------------------------
// 本文件只声明「加载一个已扫描到的插件会得到什么」：状态机、注入依赖、每项结果。
// 编排逻辑在 pluginLoader.ts，工具闸门在 pluginToolGate.ts，导出解析在 pluginModuleExports.ts。
//
// 状态机取自 docs/plugin-ecosystem-blueprint.md 第 5 节，并按「未决（已拍板）」第 1 条
// （目录存在即信任）删去 pending_consent：core 侧不做确认门。disabled 是用户动作的结果，
// 由 P5 的设置面板持有，不属于一次加载的产物。

import type { PluginApiVersionRange, PluginCapability } from './manifestTypes'
import type { PluginDisposer, PublicPlugin } from '../runtime/core/pluginContracts'
import type { PluginIdentity } from '../runtime/core/pluginHost'

/**
 * 一次加载的终态。入口状态 `discovered` 由 P3 扫描器给出，本层只产出这三个终态之一：
 * - `enabled`：已 import、已通过 branded 校验、已安装进 plugin host，持有 disposer。
 * - `incompatible`：插件本身没问题，但当前宿主装不了它（apiVersion 不在支持区间；
 *   或只声明了 react 入口——本加载器只装 core 侧入口，见蓝图第 3.4 节）。
 * - `failed`：manifest 非法、import 抛错、导出不合规、安装期预检失败。
 */
export type LoadedPluginStatus = 'enabled' | 'incompatible' | 'failed'

/** 本层无法验证、由宿主 importModule 约定保证的事项标记（随结果带出，供 P5/P7 显示与跟进）。 */
export const TOP_LEVEL_SIDE_EFFECT_TODO =
  'TODO(top-level-side-effects): core 只能保证「经 PluginInstallApi 的注册必须发生在 install 回调内」；'
  + '插件模块 top-level 直接触达宿主全局（DOM、fetch、Tauri IPC）无法在 core 侧检测，'
  + '第一期由宿主的 importModule 求值策略约定保证（蓝图第 3.4 节：capabilities 是申报不是沙箱）'

/** 加载器需要宿主提供的安装面。runtime/core/pluginHost 的 PluginHost 结构上满足它。
 *  identity 透传给 host——熔断（P7）按 identity.id 计数并归因，manifest 解析出的
 *  id/name/version 结构上满足 PluginIdentity，调用方不必额外裁剪字段。 */
export interface PluginInstallHost {
  installPlugin(plugin: PublicPlugin, identity: PluginIdentity): { dispose: PluginDisposer }
}

/** 注入依赖：core 不做 IO，也不决定「怎么把一个路径变成模块」。 */
export interface PluginLoaderDeps {
  /**
   * 动态导入插件入口，返回模块命名空间（或任何值——解析与拒绝由本层负责）。
   * 入参是 workspace 相对 POSIX 路径 `.webAgent/plugins/<dir>/<entry.core>`；
   * 宿主自己决定转成 file URL import（CLI/Node）还是读字节后 blob 求值（Tauri）。
   * 抛错即视为该插件加载失败，不影响其余插件。
   */
  importModule(entryPath: string): Promise<unknown>
  /** 安装面：拿到 branded 插件后装进 plugin host，换回 disposer。 */
  host: PluginInstallHost
  /** 宿主声明的 apiVersion 支持区间（闭区间）。 */
  apiVersionRange: PluginApiVersionRange
  /**
   * 模型可见工具的勾选闸门（拍板 3）。缺省 = 一律不勾选，即「默认关」。
   * P6 会把设置页里按用户存的勾选记录接到这里；本卡只保证默认关这半边。
   */
  isToolEnabled?(pluginId: string, toolName: string): boolean
}

/** 一个插件的加载结果。enabled 时才有 dispose。 */
export interface LoadedPlugin {
  /** `.webAgent/plugins/` 下的子目录名，与 ScannedPlugin 对齐。 */
  readonly dirName: string
  readonly status: LoadedPluginStatus
  /** manifest 解析成功才有；失败项只有 dirName 可用于定位。 */
  readonly id?: string
  readonly name?: string
  readonly version?: string
  /** 实际交给 importModule 的路径；只有走到 import 这一步才有值。 */
  readonly entryPath?: string
  /** 人类可读诊断：扫描期诊断的透传 + 本层的加载/安装诊断，供设置页直接展示。 */
  readonly diagnostics: readonly string[]
  /** 真正注册进 registry 的工具名。 */
  readonly grantedTools: readonly string[]
  /** 被闸门拦下的模型可见工具名——P6 的勾选面就渲染这一列。 */
  readonly withheldTools: readonly string[]
  /** 申报了但宿主不授予的能力，当前只有 `timeline.persist`（R5 未批）。 */
  readonly deniedCapabilities: readonly PluginCapability[]
  /** 卸载：撤销工具注册与安装期资源。仅 enabled 项存在。 */
  readonly dispose?: PluginDisposer
}

export interface PluginLoadResult {
  /** 与入参 scanned 一一对应、顺序一致：坏项也留在列表里（status 为 failed/incompatible），
   * 设置页据此渲染一份完整清单，不会有"扫到了但列表里没有"的空洞。 */
  readonly plugins: readonly LoadedPlugin[]
  /** 本层验不了、由宿主约定保证的事项。内容恒为 TOP_LEVEL_SIDE_EFFECT_TODO。 */
  readonly unverified: readonly string[]
}
