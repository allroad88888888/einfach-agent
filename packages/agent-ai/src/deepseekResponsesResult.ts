import type {
  ModelChatResponse,
  ModelResponseMessage,
  ModelResponseToolCall,
  ModelStreamDelta,
  ModelUsage,
} from './modelProtocol'

export interface DeepSeekResponseOutputItem {
  type?: string
  call_id?: string
  name?: string
  arguments?: string
  content?: Array<{ type?: string; text?: string }>
}

export interface DeepSeekResponsePayload {
  id?: string
  model?: string
  status?: string
  output?: DeepSeekResponseOutputItem[]
  usage?: ModelUsage
  incomplete_details?: { reason?: string } | null
  error?: { type?: string; code?: string; message?: string } | null
}

function textFrom(
  outputs: readonly DeepSeekResponseOutputItem[],
  itemType: string,
  contentType: string,
): string {
  return outputs
    .filter((item) => item.type === itemType)
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === contentType && typeof part.text === 'string')
    .map((part) => part.text ?? '')
    .join('')
}

function toolCalls(outputs: readonly DeepSeekResponseOutputItem[]): ModelResponseToolCall[] {
  return outputs
    .filter((item) => item.type === 'function_call')
    .map((item, index) => ({
      index,
      id: item.call_id,
      type: 'function' as const,
      function: { name: item.name, arguments: item.arguments ?? '' },
    }))
}

function finishReason(payload: DeepSeekResponsePayload, calls: readonly ModelResponseToolCall[]): string {
  if (calls.length > 0) return 'tool_calls'
  if (payload.status === 'incomplete') {
    return payload.incomplete_details?.reason === 'content_filter' ? 'content_filter' : 'length'
  }
  return 'stop'
}

/** Converts a complete Responses payload to the chat-shaped boundary consumed by Core. */
export function deepSeekResponseAsChat(payload: DeepSeekResponsePayload): ModelChatResponse {
  const outputs = payload.output ?? []
  const content = textFrom(outputs, 'message', 'output_text')
  const reasoning = textFrom(outputs, 'reasoning', 'reasoning_text')
  const calls = toolCalls(outputs)
  const message: ModelResponseMessage = {
    role: 'assistant',
    content: content || null,
    ...(reasoning ? { reasoning_content: reasoning } : {}),
    ...(calls.length > 0 ? { tool_calls: calls } : {}),
  }
  return {
    ...(payload.id ? { id: payload.id } : {}),
    ...(payload.model ? { model: payload.model } : {}),
    ...(payload.usage ? { usage: payload.usage } : {}),
    choices: [{ finish_reason: finishReason(payload, calls), message }],
  }
}

/** Emits one chat-compatible delta for a complete non-streaming Responses payload. */
export function deepSeekResponseDelta(payload: DeepSeekResponsePayload): ModelStreamDelta {
  const message = deepSeekResponseAsChat(payload).choices?.[0]?.message
  return {
    ...(message?.content ? { content: message.content } : {}),
    ...(message?.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
    ...(message?.tool_calls ? { tool_calls: message.tool_calls } : {}),
  }
}
