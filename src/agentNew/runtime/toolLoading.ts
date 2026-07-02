// TK3 tool lazy 加载闸门（移植自旧 loop.ts 的 appendVisibleTool / ensureToolLoaded，纯逻辑版）。
// ---------------------------------------------------------------------------
// 设计契约（FEATURES-PLAN §1 TK3）：manifest-only + lazy schema。
//   · model 只看 listToolSummaries()（无 inputSchema）；只有真正被 ensure 的 tool
//     才 loadTool() 合成完整 schema，加入本轮可见工具列表。禁止预加载。
// agentNew 无 timeline：去掉旧版 timeline 写入 / wait 延时，只保留纯逻辑。

import { loadTool, type LoadedTool } from '../tools/registry'
import { patchRun } from '../state/sessionWriters'

// 简介：把工具加入本轮可见工具列表。
// 详情：按 name 去重后返回新数组；已含则原样返回（同引用），只有出现在列表里的 schema 才会暴露给下一轮 model。
export function appendVisibleTool(current: LoadedTool[], next: LoadedTool): LoadedTool[] {
  if (current.some((tool) => tool.name === next.name)) return current
  return [...current, next]
}

// 简介：确保某个工具的 schema 已加载到本轮可见列表，并把累计已载写回 run。
// 详情：列表已含该 name → 原样返回；否则 loadTool(toolName)（未知 tool → undefined → 原样返回）→
// appendVisibleTool 加入 → patchRun(id, { loadedTools }) 累计已载 → 返回新数组。
export function ensureToolLoaded(
  id: string,
  currentTools: LoadedTool[],
  toolName: string,
): LoadedTool[] {
  if (currentTools.some((tool) => tool.name === toolName)) return currentTools

  const tool = loadTool(toolName)
  if (!tool) return currentTools

  const nextTools = appendVisibleTool(currentTools, tool)
  patchRun(id, { loadedTools: nextTools.map((loadedTool) => loadedTool.name) })

  return nextTools
}
