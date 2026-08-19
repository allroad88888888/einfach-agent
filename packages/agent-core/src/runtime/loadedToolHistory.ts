// 从历史里的 schema 加载 call/result 恢复「已成功加载过的工具名」。

import type { ModelItem } from '@einfach-agent/ai'
import { TOOL_SCHEMA_AUTOLOADED_CODE } from '../tools/schemaResult'
import { parseToolCallArgs } from './toolCallArgs'

function parsedObject(content: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(content)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    return value as Record<string, unknown>
  } catch {
    return undefined
  }
}

function loadedToolName(content: string, requestedToolName: string): string | undefined {
  const result = parsedObject(content)
  if (!result) return undefined

  const resultToolName = result.loaded === true && typeof result.toolName === 'string'
    ? result.toolName
    : typeof result.name === 'string'
        && Object.prototype.hasOwnProperty.call(result, 'inputSchema')
      ? result.name
      : undefined

  return resultToolName === requestedToolName ? resultToolName : undefined
}

// 简介：判定一条 tool 结果是不是「直接调用被当作加载请求」的产物（modelRun 的 lazy 闸门）。
// 详情：只认 code 判别码 + 工具名自洽两条硬判据，避免某个业务工具碰巧回了 {loaded:true} 就被
//   误当成一次 schema 加载。
function autoloadedToolName(
  content: string,
  calledToolName: string | undefined,
): string | undefined {
  if (!calledToolName) return undefined
  const result = parsedObject(content)
  if (!result) return undefined
  return result.code === TOOL_SCHEMA_AUTOLOADED_CODE && result.toolName === calledToolName
    ? calledToolName
    : undefined
}

// 简介：从历史的 schema 加载 call/result 恢复已成功加载的工具名。
// 详情：只读取历史、不改写发给模型的 messages。调用方应从当前 registry 重新取得最新 schema，
// 放入请求顶层 tools；原始 loader call/result 继续进入模型请求，保持缓存前缀与执行因果。
// 两个加载入口都要认账：显式的 request_tool_schema，以及【直接调用未加载工具】被闸门就地转成
// 的那一次加载 —— 后者同样让该工具此后长期可用，漏认会让重启/回滚后的会话白白重新加载一次。
export function loadedToolNamesFromHistory(messages: readonly ModelItem[]): string[] {
  const requestedByCallId = new Map<string, string>()
  const directCallByCallId = new Map<string, string>()

  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const toolCall of message.tool_calls ?? []) {
        if (toolCall.function.name !== 'request_tool_schema') {
          directCallByCallId.set(toolCall.id, toolCall.function.name)
          continue
        }
        const parsed = parseToolCallArgs(toolCall.function.arguments)
        const toolName = parsed.ok && typeof parsed.args.toolName === 'string'
          ? parsed.args.toolName.trim()
          : undefined
        if (toolName) requestedByCallId.set(toolCall.id, toolName)
      }
    }
  }

  // Set 的 delete + add 会把重复项移到迭代尾部，因此返回顺序是最旧 → 最新，
  // 可直接作为恢复期 LRU。只用首次出现顺序会让后来重新请求过的工具在恢复时被误淘汰。
  const loadedToolNames = new Set<string>()
  for (const message of messages) {
    if (message.role !== 'tool') continue
    const requestedToolName = requestedByCallId.get(message.tool_call_id)
    const loaded = requestedToolName
      ? loadedToolName(message.content, requestedToolName)
      : autoloadedToolName(message.content, directCallByCallId.get(message.tool_call_id))
    if (!loaded) continue
    loadedToolNames.delete(loaded)
    loadedToolNames.add(loaded)
  }
  return [...loadedToolNames]
}
