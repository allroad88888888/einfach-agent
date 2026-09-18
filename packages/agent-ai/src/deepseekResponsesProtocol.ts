import type { DeepSeekChatRequest, DeepSeekReasoningEffort } from './deepseek'
import { normalizeDeepSeekUserId } from './deepseekIdentity'
import { isValidInlineBase64ImageBlock } from './openAiCompatMessages'
import type {
  ModelFunctionTool,
  ModelItem,
  ModelToolChoice,
  ToolOutputContentBlock,
  UserContentBlock,
} from './modelProtocol'

interface ResponsesInputText {
  type: 'input_text'
  text: string
}

interface ResponsesInputImage {
  type: 'input_image'
  image_url?: string
  file_id?: string
  detail?: 'low' | 'high' | 'original' | 'auto'
}

type ResponsesContentPart = ResponsesInputText | ResponsesInputImage

type DeepSeekResponseInput =
  | { role: 'system' | 'user' | 'assistant'; content: string | ResponsesContentPart[] }
  | { type: 'reasoning'; content: Array<{ type: 'reasoning_text'; text: string }> }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string | ResponsesContentPart[] }

interface DeepSeekResponseTool {
  type: 'function'
  name: string
  description: string
  parameters: unknown
}

type DeepSeekResponseToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; name: string }

export interface DeepSeekResponsesRequest {
  model: string
  input: DeepSeekResponseInput[]
  tools?: DeepSeekResponseTool[]
  tool_choice?: DeepSeekResponseToolChoice
  reasoning?: { effort: 'none' | DeepSeekReasoningEffort }
  temperature?: number
  top_p?: number
  max_output_tokens?: number
  user?: string
  stream?: boolean
}

function userImage(block: Extract<UserContentBlock, { type: 'image' }>): ResponsesInputImage {
  if (block.source.kind === 'provider-file') return { type: 'input_image', file_id: block.source.reference }
  if (!isValidInlineBase64ImageBlock(block)) throw new Error('DeepSeek inline image data is invalid.')
  return {
    type: 'input_image',
    image_url: `data:${block.mimeType};base64,${block.source.data}`,
  }
}

function userContent(blocks: readonly UserContentBlock[]): ResponsesContentPart[] {
  return blocks.map((block) => block.type === 'text'
    ? { type: 'input_text', text: block.text }
    : userImage(block))
}

function toolImage(block: Extract<ToolOutputContentBlock, { type: 'image' }>): ResponsesInputImage {
  if (block.source.kind !== 'inline-base64' || !isValidInlineBase64ImageBlock(block)) {
    throw new Error('DeepSeek tool image output requires valid inline base64 data.')
  }
  return {
    type: 'input_image',
    image_url: `data:${block.mimeType};base64,${block.source.data}`,
    ...(block.detail ? { detail: block.detail } : {}),
  }
}

function toolContent(content: readonly ToolOutputContentBlock[]): ResponsesContentPart[] {
  return content.map((block) => block.type === 'text'
    ? { type: 'input_text', text: block.text }
    : toolImage(block))
}

function assistantInput(message: Extract<ModelItem, { role: 'assistant' }>): DeepSeekResponseInput[] {
  const calls = message.tool_calls ?? []
  const reasoning = typeof message.reasoning_content === 'string'
    ? message.reasoning_content
    : calls.length > 0 ? ' ' : undefined
  return [
    ...(reasoning === undefined ? [] : [{
      type: 'reasoning' as const,
      content: [{ type: 'reasoning_text' as const, text: reasoning }],
    }]),
    ...(typeof message.content === 'string' && message.content.length > 0
      ? [{ role: 'assistant' as const, content: message.content }]
      : []),
    ...calls.map((call) => ({
      type: 'function_call' as const,
      call_id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
    })),
  ]
}

function responseInputs(messages: readonly ModelItem[]): DeepSeekResponseInput[] {
  return messages.flatMap((message): DeepSeekResponseInput[] => {
    if (message.role === 'system') return [{ role: 'system', content: message.content }]
    if (message.role === 'user') {
      return [{
        role: 'user',
        content: typeof message.content === 'string'
          ? message.content
          : userContent(message.content),
      }]
    }
    if (message.role === 'assistant') return assistantInput(message)
    return [{
      type: 'function_call_output',
      call_id: message.tool_call_id,
      output: message.model_content ? toolContent(message.model_content) : message.content,
    }]
  })
}

function responseTools(tools: readonly ModelFunctionTool[] | undefined): DeepSeekResponseTool[] | undefined {
  return tools?.map((tool) => ({
    type: 'function',
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  }))
}

function responseToolChoice(choice: ModelToolChoice | undefined): DeepSeekResponseToolChoice | undefined {
  return typeof choice === 'object'
    ? { type: 'function', name: choice.function.name }
    : choice
}

function reasoning(body: DeepSeekChatRequest): DeepSeekResponsesRequest['reasoning'] {
  if (body.thinking?.type === 'disabled') return { effort: 'none' }
  if (body.reasoning_effort) return { effort: body.reasoning_effort }
  return undefined
}

/** Projects provider-neutral chat history into DeepSeek's stateless Responses wire format. */
export function prepareDeepSeekResponsesRequest(body: DeepSeekChatRequest): DeepSeekResponsesRequest {
  const tools = responseTools(body.tools)
  const toolChoice = responseToolChoice(body.tool_choice)
  const reasoningConfig = reasoning(body)
  const user = normalizeDeepSeekUserId(body.user_id)
  return {
    model: body.model,
    input: responseInputs(body.messages),
    ...(tools ? { tools } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
    ...(reasoningConfig ? { reasoning: reasoningConfig } : {}),
    ...(body.thinking?.type === 'enabled' ? {} : { temperature: body.temperature, top_p: body.top_p }),
    ...(body.max_tokens === undefined ? {} : { max_output_tokens: body.max_tokens }),
    ...(user === undefined ? {} : { user }),
    stream: body.stream,
  }
}

/** Structured tool outputs require Responses; Chat Completions only accepts tool text. */
export function deepSeekRequestNeedsResponses(
  model: string,
  messages: readonly ModelItem[],
): boolean {
  return model === 'deepseek-flash'
    && messages.some((message) => message.role === 'tool' && message.model_content !== undefined)
}
