// DeepSeek 的接口调用。
// ---------------------------------------------------------------------------
// 共享线协议类型与底层 postChatCompletion 在 ./modelApi；这里只放 DeepSeek 的请求
// 特化与调用入口。

import {
  postChatCompletion,
  postChatCompletionStream,
  type ChatCallOptions,
  type ChatStreamHandlers,
  type ChatRequestBase,
  type ModelChatResponse,
  type ModelFinishReasonExtension,
  type ModelRetryObserver,
  type ModelResponseMessage,
  type ModelStreamDelta,
} from './modelApi'
import { encodeDeepSeekMessages, type DeepSeekWireItem } from './deepseekMessages'
import { nonVisualMessages } from './nonVisualMessages'

// 简介：DeepSeek 接入点与默认模型。
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'
export const DEEPSEEK_PRO_MODEL = 'deepseek-v4-pro'
export const DEEPSEEK_FLASH_MODEL = 'deepseek-v4-flash'
export const DEEPSEEK_VISION_MODEL = 'deepseek-v4-flash-vision-exp'
export const DEFAULT_DEEPSEEK_MODEL = DEEPSEEK_PRO_MODEL
export const MAX_DEEPSEEK_USER_ID_LENGTH = 512

/**
 * 模型名 → 面向用户的展示名。
 *
 * **和常量放在同一个文件里，是为了让「改默认档」不可能只改一半。** 之前设置面板把展示名写死成
 * "DeepSeek V4 Flash" 摆在 `DEFAULT_DEEPSEEK_MODEL` 旁边，而 f838544 把默认换成 Pro 时只动了
 * 这个常量和一条测试 —— 面板于是长期显示 `deepseek-v4-pro` 配 "DeepSeek V4 Flash"，
 * 同一张卡自相矛盾，而且没有任何门禁能发现（那是一句中文字面量）。
 * 现在展示名从模型名查表得来，换默认值时文案自动跟着走。
 */
export const DEEPSEEK_MODEL_LABELS: Readonly<Record<string, string>> = {
  [DEEPSEEK_PRO_MODEL]: 'DeepSeek V4 Pro',
  [DEEPSEEK_FLASH_MODEL]: 'DeepSeek V4 Flash',
  [DEEPSEEK_VISION_MODEL]: 'DeepSeek V4 Flash Vision Experimental',
}

// 简介：校验 DeepSeek 官方 user_id 线协议约束。
// 详情：不 trim、不截断——任何超长或带其它字符的值都整体拒绝，避免把邮箱、文件路径等
// 隐私数据“修剪”成另一个仍会被发送的标识。调用方应只传本地生成的不透明随机 ID。
export function normalizeDeepSeekUserId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  if (value.length === 0 || value.length > MAX_DEEPSEEK_USER_ID_LENGTH) return undefined
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : undefined
}

// 简介：DeepSeek V4 的推理投入档位。
// 详情：V4 只接受 high / max；旧的 low / medium 最终也只会被服务端映射成 high。
export type DeepSeekReasoningEffort = 'high' | 'max'

const MAX_INSUFFICIENT_RESOURCE_RETRIES = 1
const INSUFFICIENT_RESOURCE_FINISH_REASON = 'insufficient_system_resource'

const INSUFFICIENT_RESOURCE_EXTENSION: ModelFinishReasonExtension = {
  reason: INSUFFICIENT_RESOURCE_FINISH_REASON,
  error: '模型服务容量不足（finish_reason=insufficient_system_resource），请稍后重试',
  itemNotice:
    '\n\n> ⚠️ 【系统标注】以上回复因模型服务容量不足而中断（finish_reason=insufficient_system_resource），内容不完整。',
  standaloneNotice:
    '> ⚠️ 【系统标注】本轮回复因模型服务容量不足而中断（finish_reason=insufficient_system_resource），未产生任何内容。',
  // 同模型重试已在下面的 streamWithCapacityRetry 里做过一次；这一位是说给「换模型」那一层听的
  // （modelCapacityEscalation）：本家这个终态属于容量耗尽，换个模型值得再试一次。
  capacityExhausted: true,
}

/** Resolves DeepSeek-only terminal semantics without leaking them into the common protocol. */
export function deepSeekFinishReasonExtensionFor(
  reason: string | null,
): ModelFinishReasonExtension | undefined {
  return reason === INSUFFICIENT_RESOURCE_FINISH_REASON ? INSUFFICIENT_RESOURCE_EXTENSION : undefined
}

export function deepSeekFinishReasonExtensions(): readonly ModelFinishReasonExtension[] {
  return [INSUFFICIENT_RESOURCE_EXTENSION]
}

// 简介：发给 DeepSeek 的请求体。
// 详情：公共字段来自 ChatRequestBase，仅 reasoning_effort 取值域为 DeepSeek 特化。
export interface DeepSeekChatRequest extends ChatRequestBase {
  reasoning_effort?: DeepSeekReasoningEffort
  user_id?: string
  top_p?: number
  presence_penalty?: number
  frequency_penalty?: number
}

interface DeepSeekWireChatRequest extends Omit<DeepSeekChatRequest, 'messages'> {
  messages: DeepSeekWireItem[]
}

// 简介：规范化 DeepSeek V4 thinking 工具调用历史。
// 详情：官方协议要求工具调用续轮完整回传 assistant 的 reasoning_content；同时工具调用
// assistant 的 content 不能为 null。这里把纯工具调用轮的 null content 规范为空字符串，并给
// 缺失 reasoning_content 的工具调用 assistant 补空串——core 为孤儿 timed tool result 合成的
// 配对 assistant（timedToolResultProjection）没有推理正文，thinking 模式下缺字段会被服务端
// 400（"reasoning_content ... must be passed back"）；空串已实测可过校验。不修改调用方原始
// messages。
function prepareDeepSeekThinkingMessages(
  messages: DeepSeekChatRequest['messages'],
): DeepSeekChatRequest['messages'] {
  return messages.map((message) => {
    if (message.role !== 'assistant' || (message.tool_calls?.length ?? 0) === 0) return message
    const content = message.content === null ? '' : message.content
    const reasoning = typeof message.reasoning_content === 'string' ? message.reasoning_content : ''
    if (content === message.content && reasoning === message.reasoning_content) return message
    return { ...message, content, reasoning_content: reasoning }
  })
}

// 简介：按 DeepSeek V4 thinking 协议净化请求。
// 详情：thinking 开启时，DeepSeek 不支持四个采样参数，也不接受 tool_choice。调用方的
// 会话设置仍需保留，因此这里只创建一个兼容的新对象，不修改传入 body。
function prepareDeepSeekRequest(body: DeepSeekChatRequest): DeepSeekWireChatRequest {
  const {
    user_id: rawUserId,
    tool_choice: rawToolChoice,
    temperature: _temperature,
    top_p: _topP,
    presence_penalty: _presencePenalty,
    frequency_penalty: _frequencyPenalty,
    ...baseRequest
  } = body
  // 工具调用轮归一化不看请求级 thinking 开关：DeepSeek 服务端已把 deepseek-chat 等别名
  // 路由到 thinking 家族（实测请求 deepseek-chat 返回 model=deepseek-v4-flash），请求未声明
  // thinking 时缺 reasoning_content 一样会 400；非 thinking 路径带空串字段已实测可过校验。
  const normalizedMessages = prepareDeepSeekThinkingMessages(body.messages)
  const messages: DeepSeekWireItem[] = body.model === DEEPSEEK_VISION_MODEL
    ? encodeDeepSeekMessages(normalizedMessages, body.model)
    // nonVisualMessages guarantees every structured user item becomes string content.
    : nonVisualMessages(normalizedMessages) as DeepSeekWireItem[]
  const userId = normalizeDeepSeekUserId(rawUserId)
  const request = userId === undefined ? baseRequest : { ...baseRequest, user_id: userId }

  if (body.thinking?.type === 'enabled') {
    return {
      ...request,
      messages,
    }
  }

  return {
    ...request,
    messages,
    tool_choice: rawToolChoice,
    temperature: body.temperature,
    top_p: body.top_p,
    presence_penalty: body.presence_penalty,
    frequency_penalty: body.frequency_penalty,
  }
}

function withStreamUsage(body: DeepSeekWireChatRequest): DeepSeekWireChatRequest {
  return {
    ...body,
    stream_options: {
      ...body.stream_options,
      // DeepSeek 只有 include_usage=true 才在 [DONE] 前补发最终 usage chunk。
      // 尊重调用方显式关闭；未指定时默认打开，保证缓存命中统计可见。
      include_usage: body.stream_options?.include_usage ?? true,
    },
  }
}

function messageCarriesOutput(message: ModelResponseMessage | undefined): boolean {
  if (typeof message?.content === 'string' && message.content.length > 0) return true
  if (typeof message?.reasoning_content === 'string' && message.reasoning_content.length > 0) return true
  return Array.isArray(message?.tool_calls) && message.tool_calls.length > 0
}

function deltaCarriesOutput(delta: ModelStreamDelta): boolean {
  if (typeof delta.content === 'string' && delta.content.length > 0) return true
  if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) return true
  return Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0
}

// 简介：调用 DeepSeek 的 chat/completions（一次性完整响应）。
// 详情：默认接入 DEEPSEEK_BASE_URL，可由 options.baseUrl 覆盖。
export function callDeepSeek(
  body: DeepSeekChatRequest,
  options: ChatCallOptions,
): Promise<ModelChatResponse> {
  return postChatCompletion(
    options.baseUrl ?? DEEPSEEK_BASE_URL,
    prepareDeepSeekRequest(body),
    options,
  )
}

// 简介：调用 DeepSeek 的 chat/completions（流式）。
// 详情：delta 通过 handlers.onDelta 增量回调，最终仍 resolve 为完整 ModelChatResponse。
export function streamDeepSeek(
  body: DeepSeekChatRequest,
  options: ChatCallOptions,
  handlers?: ChatStreamHandlers,
  retryObserver?: ModelRetryObserver,
): Promise<ModelChatResponse> {
  return streamWithCapacityRetry(body, options, handlers, retryObserver)
}

async function streamWithCapacityRetry(
  body: DeepSeekChatRequest,
  options: ChatCallOptions,
  handlers: ChatStreamHandlers | undefined,
  retryObserver: ModelRetryObserver | undefined,
): Promise<ModelChatResponse> {
  let retryCount = 0

  for (;;) {
    let emittedOutput = false
    const response = await postChatCompletionStream(
      options.baseUrl ?? DEEPSEEK_BASE_URL,
      withStreamUsage(prepareDeepSeekRequest(body)),
      options,
      {
        onDelta(delta) {
          emittedOutput ||= deltaCarriesOutput(delta)
          handlers?.onDelta?.(delta)
        },
      },
    )
    const message = response.choices?.[0]?.message
    const capacityLimited = response.choices?.[0]?.finish_reason === INSUFFICIENT_RESOURCE_FINISH_REASON
    const canRetry = retryObserver?.canRetry?.() ?? !options.signal?.aborted

    if (!capacityLimited) {
      if (retryCount > 0) {
        retryObserver?.onRetry?.({
          status: 'recovered',
          attempt: retryCount,
          maxRetries: MAX_INSUFFICIENT_RESOURCE_RETRIES,
          response,
        })
      }
      return response
    }

    if (emittedOutput || messageCarriesOutput(message) || !canRetry) {
      retryObserver?.onRetry?.({
        status: 'exhausted',
        attempt: retryCount,
        maxRetries: MAX_INSUFFICIENT_RESOURCE_RETRIES,
        response,
      })
      return response
    }

    if (retryCount >= MAX_INSUFFICIENT_RESOURCE_RETRIES) {
      retryObserver?.onRetry?.({
        status: 'exhausted',
        attempt: retryCount,
        maxRetries: MAX_INSUFFICIENT_RESOURCE_RETRIES,
        response,
      })
      return response
    }

    retryCount += 1
    retryObserver?.onRetry?.({
      status: 'retrying',
      attempt: retryCount,
      maxRetries: MAX_INSUFFICIENT_RESOURCE_RETRIES,
      response,
    })
  }
}
