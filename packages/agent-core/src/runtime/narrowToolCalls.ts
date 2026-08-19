// 把模型响应里的宽松 tool_calls 收窄成请求侧必填形状。

import type { ModelResponseToolCall, ModelToolCall } from '@einfach-agent/ai'
import { newId } from './newId'

// 简介：把响应里的宽松 tool_calls 收窄成请求侧必填的 ModelToolCall[]。
// 详情：丢弃缺 function.name 的项（无从分发）；id 缺失时自造一个稳定 id —— 同一份收窄结果既
// 用于 appendItem assistant.tool_calls、也用于逐个产出 ToolItem.tool_call_id，二者天然一致。
export function narrowToolCalls(raw: ModelResponseToolCall[] | undefined): ModelToolCall[] {
  if (!raw) return []
  return raw
    .filter((toolCall) => toolCall.function?.name)
    .map((toolCall) => ({
      id: toolCall.id ?? newId(),
      type: 'function' as const,
      function: {
        name: toolCall.function!.name!,
        arguments: toolCall.function!.arguments ?? '',
      },
    }))
}
