// 当前环境与权限下「可发现的工具目录视图」：一份判据，供 manifest 分页与 visible 展开共用。

import { toolRegistry } from '../tools/registry'
import type { ToolCatalog } from '../tools/toolCatalog'
import type { ToolRuntime, ToolSummary } from '../tools/types'
import { compareStableText } from './shared/stableTextOrder'

// TP3 判据：server 工具依赖宿主的本机能力（shell / 文件系统 / Git / rg），宿主给不出这些能力时
// 不暴露给 model。manifest 分页与 visible 展开共用此谓词，保证「能发现的」与「能看见的」判据一致。
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

/**
 * 工具可见性的总闸。
 *
 * 【为什么参数按能力措辞】（H4b）第二个参数一路上曾经按宿主品牌命名，源头是
 * `modelTurnPrefix.ts` 里的一次品牌探测——于是「宿主能不能执行 runtime='server' 的工具」被写死
 * 成了「是不是跑在某个特定 webview 里」。这两件事从来就不是一回事：本机能力来自宿主提供的命令桥
 * （见 hostBridge.ts），桥背后是本地 Node 后端还是别的什么，与 core 无关。现在源头
 * 改读 `hasHostBridge()`，参数名跟着改成「宿主有没有本机能力」这个它真正回答的问题——留着按品牌
 * 命名的旧名字，将来读到 `runtime !== 'server' || <品牌>` 的人只会得到一个错误答案。
 *
 * 【MCP stdio 占位的窗口期】（H4b 结论，不在本卡实现）stdio MCP 的占位工具登记为
 * runtime='server'（tools/mcp/src/placeholderTool.ts），此前正是靠这道闸在浏览器下被整类过滤掉。
 * 闸门改判「有没有桥」之后，一个**非 Tauri 的 server 宿主**（本地 Node 后端，B 线）会让这些占位
 * 变成可见，而 stdio 的 Node 实现要等 C 线才有——中间存在「可见但不可用」的窗口。判定为**可接受**：
 *   · 写这段时为零风险：那时唯一有桥的宿主就是桌面端，纯浏览器下没有桥，两种现存宿主的
 *     行为与改动前逐字节相同；这个窗口只在一个当时尚不存在的宿主上才打开。
 *   · 失败是有界且诚实的：占位的 execute 会走透明连接，连接器缺席时得到的是一条工具失败结果，
 *     与「MCP 服务连不上」同类，占位 guide 本来就向模型交代了「这是未连接服务的历史条目」。
 *   · 现在就切更细的粒度是投机：本地 Node 后端几乎必然能起子进程，那样 stdio 需要的能力与 shell
 *     完全相同，细分维度会白做。真到了需要修的那天，正确位置也不在这里——「宿主有没有本机能力」
 *     是本文件的判据，「这个占位现在该不该存在」是 placeholderSync 的判据（没有 stdio 连接器就
 *     别同步 stdio 占位），把它塞进 ToolRuntime 会让两个判断挤在同一个维度上。
 */
export function isToolVisible(runtime: ToolRuntime, hostHasLocalCapabilities: boolean): boolean {
  return runtime !== 'server' || hostHasLocalCapabilities
}

export function availableToolSummaries(
  hostHasLocalCapabilities: boolean,
  options?: BuildTurnToolsOptions,
): ToolSummary[] {
  return (options?.registry ?? toolRegistry)
    .list()
    .filter((tool) =>
      tool.name !== 'request_tool_schema'
      && isToolVisible(tool.runtime, hostHasLocalCapabilities)
      && isToolAllowed(tool.name, options))
    .sort((left, right) =>
      compareStableText(left.name, right.name)
      || compareStableText(left.description, right.description)
      || compareStableText(left.runtime, right.runtime))
}
