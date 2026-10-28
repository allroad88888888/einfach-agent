import type { ModelItem, ModelToolCall } from '@einfach-agent/ai'

const TIMED_TOOL_CALL_ID_PREFIX = 'timed:'
const SYNTHETIC_TIMED_TOOL_NAME = 'timed_tool_result'

/**
 * 为仅存在于 timeline 的 timed tool result 补齐请求协议配对。
 *
 * timed dispatcher 故意只持久化 role:'tool' 结果：它没有模型发起的 assistant tool_call，不能把伪造
 * assistant 写回会话历史。chat/completions 的请求序列则要求 tool result 紧跟声明同 id 的
 * assistant tool_calls；所以只在这份即将送入模型的数组中、紧贴孤儿 timed result 前合成配对项。
 *
 * 合成项固定为同 call id、空 content / reasoning_content、`timed_tool_result` / `{}`。
 * 它没有经历模型推理，因此思考内容明确为空；不能依赖厂商 adapter 为它补字段，通用兼容
 * adapter 会原样透传。只补全运行时自己生成的项，真实 assistant 的推理内容原样保留。
 *
 * 作用域只限 `timed:`：非 timed 的未知孤儿是原始历史或上游协议问题，本投影不应掩盖它们。
 */
export function projectTimedToolResultOrphans(messages: ModelItem[]): ModelItem[] {
  let declaredCallIds: Set<string> | undefined
  let projected: ModelItem[] | undefined

  for (const [index, message] of messages.entries()) {
    if (message.role === 'tool') {
      const declared = declaredCallIds?.has(message.tool_call_id) ?? false
      if (!declared && message.tool_call_id.startsWith(TIMED_TOOL_CALL_ID_PREFIX)) {
        projected ??= messages.slice(0, index)
        projected.push(syntheticAssistantToolCall(message.tool_call_id), message)
        // 该合成 call 已由紧随的当前 tool result 消费；但原 assistant 仍可能有未消费的
        // 多个 call，不能清空其声明集合，否则后续带 timed: 前缀的合法 result 会被误判为孤儿。
        continue
      }
      if (declared) declaredCallIds?.delete(message.tool_call_id)
      projected?.push(message)
      continue
    }

    declaredCallIds = message.role === 'assistant' && message.tool_calls?.length
      ? new Set(message.tool_calls.map((call) => call.id))
      : undefined
    projected?.push(message)
  }

  return projected ?? messages
}

function syntheticAssistantToolCall(callId: string): ModelItem {
  const toolCall: ModelToolCall = {
    id: callId,
    type: 'function',
    function: { name: SYNTHETIC_TIMED_TOOL_NAME, arguments: '{}' },
  }
  return { role: 'assistant', content: '', reasoning_content: '', tool_calls: [toolCall] }
}
