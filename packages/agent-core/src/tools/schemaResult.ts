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
