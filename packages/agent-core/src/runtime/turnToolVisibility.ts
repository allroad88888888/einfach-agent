// 当前环境与权限下「可发现的工具目录视图」：一份判据，供 manifest 分页与 visible 展开共用。

import { toolRegistry } from '../tools/registry'
import type { ToolCatalog } from '../tools/toolCatalog'
import type { ToolRuntime, ToolSummary } from '../tools/types'
import { compareStableText } from './shared/stableTextOrder'

// TP3 判据：server 工具依赖 Tauri 本机能力（shell/文件系统），web 下不可用 → 不暴露给 model。
// manifest 分页与 visible 展开共用此谓词，保证「能发现的」与「能看见的」判据一致。
export interface BuildTurnToolsOptions {
  allowedToolNames?: readonly string[]
  // 【登记反转 · TS1 收口】manifest 搜索必须读绑定 core 的 registry，而非模块级
  // toolRegistry（＝ defaultCore.tools）。缺省回落仅用于 defaultCore 路径。
  // 类型是只读的 ToolCatalog：run 会在这里塞自己的工具集 epoch，让发现面与注入的 manifest 同源。
  registry?: ToolCatalog
  /** 请求所用 provider；省略时使用保守 fallback descriptor。 */
  vendor?: string
  /** 请求顶层 tools 的总数预算；只能在 provider descriptor 上限内下调。 */
  maxTools?: number
  /**
   * 最近请求过 schema 的工具名，新 → 旧。
   * 它让一个已加载但被预算淘汰的旧工具在再次请求后立即回到工作集；最终线上顺序仍按名称排序。
   */
  recentToolNames?: readonly string[]
}

export function isToolAllowed(name: string, options?: BuildTurnToolsOptions): boolean {
  return !options?.allowedToolNames || options.allowedToolNames.includes(name)
}

export function isToolVisible(runtime: ToolRuntime, isTauri: boolean): boolean {
  return runtime !== 'server' || isTauri
}

export function availableToolSummaries(
  isTauri: boolean,
  options?: BuildTurnToolsOptions,
): ToolSummary[] {
  return (options?.registry ?? toolRegistry)
    .list()
    .filter((tool) =>
      tool.name !== 'request_tool_schema'
      && isToolVisible(tool.runtime, isTauri)
      && isToolAllowed(tool.name, options))
    .sort((left, right) =>
      compareStableText(left.name, right.name)
      || compareStableText(left.description, right.description)
      || compareStableText(left.runtime, right.runtime))
}
