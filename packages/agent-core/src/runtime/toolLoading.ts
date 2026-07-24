// TK3 tool lazy 加载闸门（移植自旧 loop.ts 的 appendVisibleTool / ensureToolLoaded，纯逻辑版）。
// ---------------------------------------------------------------------------
// 设计契约：manifest-only + lazy schema。
//   · model 只看 listToolSummaries()（无 inputSchema）；只有真正被 ensure 的 tool
//     才 loadTool() 合成完整 schema，加入本轮可见工具列表。禁止预加载。
// agentNew 无 timeline：去掉旧版 timeline 写入 / wait 延时，只保留纯逻辑。
//
// 【实例化 · 第 3 期穿线】ensureToolLoaded 补了尾参 core（CoreInstance，默认 defaultCore）：
//   函数体内一律经传入的 core 读写——模块级 toolRegistry → core.tools，未穿 core 的 patchRun(...) →
//   patchRun(..., core)（sessionWriters 的 patchRun 第 2 期已支持 core 尾参）。默认值就是
//   defaultCore（= 穿线前的模块全局单例；tools/registry.ts 导出的 toolRegistry 本身也只是
//   defaultCore.tools 的视图），所以【不传 core 的调用点（modelRun.ts 现有调用 + 全部现有测试）
//   行为逐字不变】。传入独立 core（如 createCoreInstance() 造的实例）时，schema 只从该 core 自己的
//   工具注册表懒加载、累计的 loadedTools 也只回落该 core 自己的 run，与 defaultCore 互不污染
//   （第 3 期隔离证明，见 toolLoading.test.ts）。

import type { LoadedTool } from '../tools/types'
import { patchRun } from '../state/sessionWriters'
import { defaultCore, type CoreInstance } from './core/coreInstance'

// 简介：给“模型调用了本轮未暴露工具”生成可自愈的结构化结果。
// 详情：不泄漏未加载 schema，只明确指出 lazy-tool 协议和下一次应发起的元工具调用。
// 主 Agent 用统一载荷代替含糊的参数缺失或 not allowed，便于模型按 nextCall 自愈。
export function toolSchemaNotLoadedResult(toolName: string): Record<string, unknown> {
  return {
    error: `工具 ${toolName} 的 schema 尚未加载，不能直接调用`,
    code: 'tool_schema_not_loaded',
    hint: '请先调用 request_tool_schema，读取完整参数 schema 后再重新调用该工具',
    nextCall: {
      name: 'request_tool_schema',
      arguments: {
        toolName,
        reason: `调用 ${toolName} 前加载参数 schema`,
      },
    },
  }
}

// 简介：把工具加入本轮可见工具列表。
// 详情：按 name 去重后返回新数组；已含则原样返回（同引用），只有出现在列表里的 schema 才会暴露给下一轮 model。
export function appendVisibleTool(current: LoadedTool[], next: LoadedTool): LoadedTool[] {
  if (current.some((tool) => tool.name === next.name)) return current
  return [...current, next]
}

// 简介：确保某个工具的 schema 已加载到本轮可见列表，并把累计已载写回 run。
// 详情：列表已含该 name → 原样返回；否则 core.tools.loadSchema(toolName)（未知 tool → undefined →
// 原样返回）→ appendVisibleTool 加入 → patchRun(id, { loadedTools }, core) 累计已载 → 返回新数组。
// core 默认 defaultCore，语义见文件头。
export function ensureToolLoaded(
  id: string,
  currentTools: LoadedTool[],
  toolName: string,
  core: CoreInstance = defaultCore,
): LoadedTool[] {
  if (currentTools.some((tool) => tool.name === toolName)) return currentTools

  const tool = core.tools.loadSchema(toolName)
  if (!tool) return currentTools

  const nextTools = appendVisibleTool(currentTools, tool)
  patchRun(id, { loadedTools: nextTools.map((loadedTool) => loadedTool.name) }, core)

  return nextTools
}
