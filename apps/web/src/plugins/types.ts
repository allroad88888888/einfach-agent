// apps/web/src/plugins/types.ts —— 插件设置面板的 view-state 契约
// ---------------------------------------------------------------------------
// 本文件只声明「面板要读什么、要注入什么」，不含编排逻辑（见 service.ts）与
// atom 定义（见 state.ts）。设计对齐 apps/web/src/mcp/ 的应用层组织方式：
// core 的 P4 产物（LoadedPlugin / PluginLoadResult，见
// packages/agent-core/src/plugins/pluginLoaderTypes.ts）经这一层转成面板可直接
// 渲染的 PluginRow，宿主接线（P10）与真实存储只需实现下面两个接口。

import type { LoadedPlugin, PluginLoadResult } from '@web-agent/core/plugins/pluginLoaderTypes'

export type { LoadedPlugin, PluginLoadResult }

/**
 * 面板展示状态。比 P4 的 LoadedPluginStatus 多两种：
 * - `disabled`：P4 里本是 `enabled`（已成功安装），但用户主动停用过——由本层结合
 *   用户存储推导，不是 core 产出的状态（pluginLoaderTypes.ts 的注释已明确
 *   disabled 属于 P5，不属于一次加载的产物）。
 * - `invalid`：P4 里合并进了 `failed`（manifest 从未解析成功，因此 identity 缺席），
 *   这里按「是否曾经拿到 id」拆回来，让面板能把"目录里根本没有合法插件"和"插件本身
 *   在导入/安装时才失败"区分开，后者更值得用户去看诊断修插件，前者往往是误放的目录。
 */
export type PluginRowStatus = 'enabled' | 'disabled' | 'failed' | 'incompatible' | 'invalid'

/** 一行插件在面板上的展示模型；不含任何函数引用（dispose 留在 service 内部持有）。 */
export interface PluginRow {
  readonly dirName: string
  readonly id?: string
  readonly name?: string
  readonly version?: string
  readonly status: PluginRowStatus
  readonly diagnostics: readonly string[]
  /** 被工具闸门拦下的模型可见工具数（P6 才会做勾选交互，本卡只展示计数）。 */
  readonly withheldToolsCount: number
  /**
   * 是否可以在这一行上点启停开关。只有真正装过（曾经是 P4 的 enabled，无论用户
   * 是否已停用）才可切换；failed/incompatible/invalid 要先解决插件自身的问题，
   * 面板不提供"重试安装"这类会掩盖根因的按钮。
   */
  readonly toggleable: boolean
}

/** 当前宿主是否支持用户插件（蓝图 3.4：首期仅桌面 + CLI，浏览器预览不支持）。 */
export interface PluginSettingsCapabilities {
  readonly supported: boolean
}

/**
 * 面板需要宿主注入的加载面。P10 会用桌面真实实现（扫描 + importModule + plugin host）
 * 接上这里；本卡（P5）只定义接口，测试用内存 fixture 驱动。
 */
export interface PluginSettingsProvider {
  readonly capabilities: PluginSettingsCapabilities
  /** 冷启动或用户点「刷新」时拉一份 P4 加载结果快照。 */
  load(): Promise<PluginLoadResult>
  /**
   * 对某一个目录重新走一次安装（等价于单独重跑一次 P4 loader），用于用户点「启用」。
   * 失败时按 P4 的错误隔离纪律返回 status: 'failed'/'incompatible' 的 LoadedPlugin，
   * 不抛异常；service 层仍会兜底捕获，防止不遵守约定的宿主实现打断其余插件。
   */
  enable(dirName: string): Promise<LoadedPlugin>
}

/** 按用户持久化的插件启停记录：key 是插件 manifest 的 id，value 为 true 表示"用户已停用"。 */
export type PluginToggleRecord = Readonly<Record<string, boolean>>

/**
 * 停用记录的存储接口（拍板 4：按用户持久化，不随 workspace/Git 走）。
 *
 * 本卡先落 localStorage 形状（见 toggleStorage.ts 的 createLocalStoragePluginToggleStorage），
 * 这在浏览器/桌面 WebView 里都是按本机 profile 隔离的，可以先顶上"按用户"这个语义；
 * P10 桌面接线时如需要更强的"按操作系统用户"落点（例如独立于 WebView 存储分区），
 * 换一个实现即可，接口不变，面板与 service 都不用改。
 */
export interface PluginToggleStorage {
  load(): PluginToggleRecord
  save(record: PluginToggleRecord): void
}
