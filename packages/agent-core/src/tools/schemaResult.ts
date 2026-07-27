import type { LoadedTool } from './types'

// request_tool_schema 的消息历史只保留一次加载确认与使用指南。
// 完整 inputSchema 会随下一轮请求的顶层 tools 字段发送，不在 role=tool 消息中重复。
export function toolSchemaLoadedResult(tool: LoadedTool): {
  loaded: true
  toolName: string
  guide: string
} {
  return {
    loaded: true,
    toolName: tool.name,
    guide: tool.guide,
  }
}

// 「直接调用未加载工具」被当作一次加载请求时的结果判别码。
// 恢复期（loadedToolNamesFromHistory）靠它把这类结果与普通工具结果区分开，
// 因此它是写进消息历史的稳定协议字节，不能随意改名。
export const TOOL_SCHEMA_AUTOLOADED_CODE = 'tool_schema_autoloaded'

// 简介：模型跳过 request_tool_schema、直接指名道姓调用未加载工具时的结果。
// 详情：这次调用本身就表达了「我要用它」，运行时据此走同一条 lazy 通道把 schema 装进下一轮
//   tools，而不是回一条纯拒绝让模型白烧一轮再来问一次。
//   ★ 两条不变量仍然成立 ★：
//     · 【不执行】——猜出来的参数一律不落地，executed:false 与 hint 都把这点写死；
//     · 【inputSchema 不进消息历史】——与 toolSchemaLoadedResult 同样只回加载确认与 guide，
//       完整 schema 只经下一轮请求的顶层 tools 字段下发。
export function toolSchemaAutoloadedResult(tool: LoadedTool): {
  loaded: true
  toolName: string
  guide: string
  code: typeof TOOL_SCHEMA_AUTOLOADED_CODE
  executed: false
  hint: string
} {
  return {
    ...toolSchemaLoadedResult(tool),
    code: TOOL_SCHEMA_AUTOLOADED_CODE,
    executed: false,
    hint: `本次调用未执行：${tool.name} 的参数 schema 此前未加载，已按 lazy-tool 协议为你加载。`
      + '完整 schema 随下一轮请求的 tools 一起下发并此后长期保留；请按它重新发起调用，'
      + '不要沿用本次猜测的参数。'
      // 每次工具集变化都会让 provider 的前缀缓存整体失效（contextCache 记一次 profile_changed）。
      // 一次性把接下来要用的都加载完，比用一次加载一个便宜得多，长会话尤其明显。
      + '若接下来还要用其它尚未加载的工具，请在同一轮用 request_tool_schema 一并加载，'
      + '避免反复改变工具集。',
  }
}
