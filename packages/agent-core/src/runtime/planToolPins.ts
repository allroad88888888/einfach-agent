// 活跃结构化计划内的 sticky 工具 profile(交接文档 P1)。
// ---------------------------------------------------------------------------
// 背景:tools 段一变,provider 的前缀缓存整段失效(2026-08-04 组装归因实测:12 轮里
// 工具集合变化 4 次是最大可控失效源)。策略:计划执行期间,已经加载过 schema 的工具
// 不再被 LRU 淘汰(pin);计划结束 / 取消 / revert / 新 run 时 pin 全部清空。
// 安全边界不变:pin 只影响「谁被淘汰」,不影响「未加载工具不得执行」的闸门,也不绕过
// maxTurnTools —— pin 集合自身超限时按可见列表的 LRU 淘汰最旧的 pin,由调用方上报
// trace(tool.plan_pinned_evicted),不做静默兜底。

import type { LoadedTool } from '../tools/types'

/**
 * 在数量上限内挑选保留的工具,pinned 优先于 LRU。
 * 无 pin 时与旧行为逐字一致(保留列表尾部的 limit 个);顺序永远保持原列表相对顺序,
 * 避免仅因淘汰重排就改变 tool 集合指纹。
 */
export function selectToolsWithinLimit(
  tools: LoadedTool[],
  limit: number | undefined,
  pinnedNames?: readonly string[],
): LoadedTool[] {
  if (limit === undefined || tools.length <= limit) return tools
  if (limit === 0) return []
  const pinnedSet = new Set(pinnedNames ?? [])
  if (pinnedSet.size === 0) return tools.slice(-limit)

  const pinned = tools.filter((tool) => pinnedSet.has(tool.name))
  if (pinned.length >= limit) {
    // pin 自身超限:保留可见顺序里最近的 limit 个 pin,淘汰最旧的(调用方负责上报)。
    const keep = new Set(pinned.slice(-limit).map((tool) => tool.name))
    return tools.filter((tool) => keep.has(tool.name))
  }
  const keep = new Set(pinned.map((tool) => tool.name))
  for (let index = tools.length - 1; index >= 0 && keep.size < limit; index -= 1) {
    keep.add(tools[index].name)
  }
  return tools.filter((tool) => keep.has(tool.name))
}

export interface NextPlanPinsResult {
  pinned: string[]
  /** 仍在注册表却不再可见的 pin —— 真实淘汰,应上报 trace;已注销的 pin 静默剪除。 */
  evicted: string[]
}

/**
 * 每轮请求前推进 pin 集合:计划不在执行态 → 全清(覆盖计划完成/取消/revert;新 run 的
 * state 本就从空开始);执行态 → pin 并集当前可见工具,已消失的 pin 分「注销」与「被淘汰」。
 */
export function nextPlanPinnedTools(args: {
  planActive: boolean
  pinned: readonly string[]
  visibleNames: readonly string[]
  isRegistered: (name: string) => boolean
}): NextPlanPinsResult {
  if (!args.planActive) return { pinned: [], evicted: [] }
  const visible = new Set(args.visibleNames)
  const evicted = args.pinned.filter((name) => !visible.has(name) && args.isRegistered(name))
  const kept = args.pinned.filter((name) => visible.has(name))
  const keptSet = new Set(kept)
  return {
    pinned: [...kept, ...args.visibleNames.filter((name) => !keptSet.has(name))],
    evicted,
  }
}
