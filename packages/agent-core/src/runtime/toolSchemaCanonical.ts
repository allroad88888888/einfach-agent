// 工具 schema 的规范化字节形态：递归排键的 canonical JSON，以及由它派生的 tool-set fingerprint。
// ---------------------------------------------------------------------------
// 目的只有一个：让同一份工具集在不同轮次、不同输入排列下产出【逐字一致】的请求前缀，
// 供 provider 前缀缓存与 contextCache 归因使用。

import type { ModelFunctionTool } from '@web-agent/ai'
import { fnv1a32 } from './shared/hash'
import { compareStableText } from './shared/stableTextOrder'

function canonicalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    // JSON Schema 数组的顺序可能有语义，也会影响模型看到的内容；只规范化数组元素里的对象。
    return value.map(canonicalizeJsonValue)
  }
  if (value === null || typeof value !== 'object') return value

  const record = value as Record<string, unknown>
  return Object.fromEntries(
    Object.keys(record)
      .sort(compareStableText)
      .map((key) => [key, canonicalizeJsonValue(record[key])]),
  )
}

/**
 * 返回递归按键名排序的新 JSON Schema，不修改注册表持有的原对象。
 * 数组保持原顺序；只有对象键会规范化，以稳定跨轮次的 tools 请求前缀。
 */
export function canonicalizeJsonSchema(
  schema: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return canonicalizeJsonValue(schema) as Record<string, unknown>
}

function canonicalTool(tool: ModelFunctionTool): ModelFunctionTool {
  return {
    type: tool.type,
    function: {
      name: tool.function.name,
      description: tool.function.description,
      parameters: canonicalizeJsonValue(tool.function.parameters),
    },
  }
}

function compareCanonicalTools(
  left: { name: string; serialized: string },
  right: { name: string; serialized: string },
): number {
  const leftRank = left.name === 'request_tool_schema' ? 0 : 1
  const rightRank = right.name === 'request_tool_schema' ? 0 : 1
  return leftRank - rightRank
    || compareStableText(left.name, right.name)
    || compareStableText(left.serialized, right.serialized)
}

/**
 * 为完整 tool-set（名称、描述和 schema）生成与输入排列无关的稳定 fingerprint。
 * request_tool_schema 与 buildTurnTools 一样固定排在第一，其余按名称排序。
 */
export function toolSetSchemaFingerprint(tools: readonly ModelFunctionTool[]): string {
  const entries = tools
    .map((tool) => {
      const canonical = canonicalTool(tool)
      return {
        name: canonical.function.name,
        serialized: JSON.stringify(canonical),
      }
    })
    .sort(compareCanonicalTools)

  const canonicalToolSet = `[${entries.map((entry) => entry.serialized).join(',')}]`
  return `tools-v1-fnv1a32-${fnv1a32(canonicalToolSet)}`
}
