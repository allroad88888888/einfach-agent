// 标准 OpenAI-compatible /chat/completions 的基线接口调用。
// ---------------------------------------------------------------------------
// 共享线协议类型与底层 postChatCompletion 在 ./modelApi；这里只放「按标准协议原样发送」
// 这一档的调用入口。与 deepseek/glm/kimi 三家 adapter 的差别是刻意的：
//   · 没有默认接入点——baseUrl 由调用方给，缺了就是配置错误，绝不猜任何厂商域名；
//   · 不做厂商私有净化——不按 thinking 剥采样参数、不补 reasoning_content、不改写
//     tool_choice，请求体原样上行。某一家的 quirk 属于那一家的 adapter，不属于这里。
// 唯一的请求投影是把结构化用户内容降级成纯文本：那不是厂商 quirk，而是本仓库内部的
// 图片块（provider-file 引用）根本不是 OpenAI 线协议的 content block，原样上行既发不出
// 合法请求，也会把内部引用泄漏给第三方端点。

import {
  postChatCompletion,
  postChatCompletionStream,
  type ChatCallOptions,
  type ChatRequestBase,
  type ChatStreamHandlers,
  type ModelChatResponse,
} from './modelApi'
import { nonVisualMessages } from './nonVisualMessages'

// 简介：本 adapter 的配置错误码。
// 详情：配置错误与线上 HTTP 失败要能被上层区分——前者重试多少次都不会好。
export type OpenAiCompatConfigErrorCode = 'missing_base_url'

// 简介：结构化的配置错误。
// 详情：沿用 modelApi 的错误约定——消息以 `Chat completion` 起头、括号里带机器可读分类，
// 且不是 RetriableError（withRetry 只重试 RetriableError），因此确定性失败不会被反复重发。
// 抛出点一律在 async 函数内，调用方拿到的是 rejected promise 而不是同步异常；除 AbortError
// 外由 core 转成运行失败展示，adapter 自己不向 UI 抛。
export class OpenAiCompatConfigError extends Error {
  readonly code: OpenAiCompatConfigErrorCode

  constructor(code: OpenAiCompatConfigErrorCode, message: string) {
    super(message)
    this.name = 'OpenAiCompatConfigError'
    this.code = code
  }
}

// 简介：发给标准 OpenAI-compatible 端点的请求体。
// 详情：公共字段来自 ChatRequestBase；这里只补上 OpenAI 标准采样参数，不引入任何
// 厂商私有字段（reasoning_effort、region、user_id 之类一律属于各家 adapter）。
export interface OpenAiCompatChatRequest extends ChatRequestBase {
  top_p?: number
  presence_penalty?: number
  frequency_penalty?: number
}

// 简介：解析必填的 baseUrl。
// 详情：标准协议没有「官方端点」这一说，空串/纯空白与缺失同罪，早失败好过发出一个
// 指向未知主机的请求。
function requireBaseUrl(options: ChatCallOptions): string {
  const baseUrl = options.baseUrl?.trim()
  if (baseUrl === undefined || baseUrl.length === 0) {
    throw new OpenAiCompatConfigError(
      'missing_base_url',
      'Chat completion requires an explicit baseUrl (missing_base_url).',
    )
  }
  return baseUrl
}

// 简介：请求投影。
// 详情：只做纯文本降级，其余字段一个不动；messages 未变时连对象都不新建，保持调用方
// 传入的 body 原样（不修改入参）。
function prepareOpenAiCompatRequest(body: OpenAiCompatChatRequest): OpenAiCompatChatRequest {
  const messages = nonVisualMessages(body.messages)
  return messages === body.messages ? body : { ...body, messages }
}

function withStreamUsage(body: OpenAiCompatChatRequest): OpenAiCompatChatRequest {
  return {
    ...body,
    stream_options: {
      ...body.stream_options,
      // 标准协议下只有 include_usage=true 才会在 [DONE] 前补发最终 usage chunk。
      // 尊重调用方显式关闭；未指定时默认打开，否则缓存命中统计直接没有数据源。
      include_usage: body.stream_options?.include_usage ?? true,
    },
  }
}

// 简介：调用标准 OpenAI-compatible 的 chat/completions（一次性完整响应）。
// 详情：baseUrl 必填，缺失时以 OpenAiCompatConfigError 拒绝，且不会发出任何请求。
export async function callOpenAiCompat(
  body: OpenAiCompatChatRequest,
  options: ChatCallOptions,
): Promise<ModelChatResponse> {
  const baseUrl = requireBaseUrl(options)
  return postChatCompletion(baseUrl, prepareOpenAiCompatRequest(body), options)
}

// 简介：调用标准 OpenAI-compatible 的 chat/completions（流式）。
// 详情：delta 通过 handlers.onDelta 增量回调，最终仍 resolve 为完整 ModelChatResponse；
// 没有厂商级重试语义，因此不接 ModelRetryObserver，传输层重试仍由 modelApi 负责。
export async function streamOpenAiCompat(
  body: OpenAiCompatChatRequest,
  options: ChatCallOptions,
  handlers?: ChatStreamHandlers,
): Promise<ModelChatResponse> {
  const baseUrl = requireBaseUrl(options)
  return postChatCompletionStream(
    baseUrl,
    withStreamUsage(prepareOpenAiCompatRequest(body)),
    options,
    handlers,
  )
}
