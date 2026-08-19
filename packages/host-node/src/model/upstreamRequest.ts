// 与上游供应商的一次 HTTP 往返：发出去、把响应头取回来、把响应体**原样**吐出来
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/model_proxy_http.rs（已随 T1 删除）。
//
// ═══ 流是怎么出去的 ═══
// 桌面侧把每个上游数据块包成 `ModelProxyEvent::Chunk` 塞进 Tauri 的 `Channel`——那是一条独立于
// 命令返回值的反向通道。Node 侧**没有**那条通道（`HostInvoke` 的签名是
// `(cmd, args) => Promise<T>`，装不下流），所以这里的出口是一个 `AsyncGenerator<Uint8Array>`：
// 谁拿到它谁负责往下送。落地形态见 forwardRequest.ts 的文件头。
//
// **一个字节都不重新编码**：不解析 SSE、不按行切、不转字符串。上游给多大的块就往下传多大的块，
// 边界原样保留。理由不只是省事——SSE 的语义带在字节边界与空行上，中间任何一层「顺手整形」都会
// 把「模型还在打字」变成「模型卡住了」。这也是为什么 chunk 上限只做**累计计数**，不做内容检查。
//
// ═══ 三种超时/中断的分工 ═══
//   · 调用方取消（`cancel_model_provider_request` 或调用方自己的 AbortSignal）→ 外部 signal，
//     结果是 `ModelRequestCancelledError`。
//   · 整体超时（120 秒，Rust `MODEL_REQUEST_TIMEOUT_SECONDS`）→ 本文件自己的计时器。发请求阶段
//     超时报「模型服务请求失败」（Rust 那边是 reqwest 的 `send()` 返回 Err），读流阶段超时报
//     「模型响应中断」（Rust 那边是 chunk 流里的 Err）。
//   · 上游把连接断了 → 读流阶段报「模型响应中断」。
// 三者都会真的把 socket 断掉：`fetch` 的 signal 一 abort，undici 立刻销毁那条连接，上游侧观察到
// 的是请求被中止，不是「读完了」。

import {
  MODEL_ERROR,
  modelRequestError,
  ModelProxyStreamError,
  ModelRequestCancelledError,
} from './errors'
import { encodeMultipartBody } from './multipartEncoding'
import type { PreparedProviderBody } from './requestBody'
import type { ResolvedProviderTarget } from './providerRoute'

/** Rust `MODEL_REQUEST_TIMEOUT_SECONDS`（120 秒），覆盖发请求到读完响应体的**全程**。 */
export const MODEL_REQUEST_TIMEOUT_MS = 120_000

/**
 * 可注入的 fetch。测试必须能替掉它——本域的测试**绝不允许**打到任何供应商的线上端点。
 * 形状与 `scripts/model-preview-relay.ts` 的注入点一致。
 */
export type ModelFetch = (url: string, init: RequestInit) => Promise<Response>

export interface UpstreamRequestInput {
  readonly target: ResolvedProviderTarget
  readonly body: PreparedProviderBody
  /** ⚠️ 明文 Key。只用于 Authorization 头；见 credentials.ts 的「Key 只进不出」。 */
  readonly apiKey: string
  /** 调用方的取消信号（来自取消表）。 */
  readonly signal: AbortSignal
  readonly fetchImpl: ModelFetch
  /** 只给测试用的超时覆盖；生产恒为 `MODEL_REQUEST_TIMEOUT_MS`。 */
  readonly timeoutMs?: number
}

export interface UpstreamResponse {
  readonly status: number
  readonly contentType?: string
  readonly retryAfter?: string
  /** 受限的字节流。超上限抛 `模型响应过大`，读断抛 `模型响应中断`，被取消抛取消错误。 */
  readonly body: AsyncGenerator<Uint8Array, void, undefined>
  /**
   * 放弃这次响应：断上游连接、清计时器与监听。可重复调用。
   *
   * 需要它是因为 generator 的 `finally` **只在 generator 被启动过之后**才可能跑到。调用方拿到
   * 响应头就决定不要了（M2 收到客户端断开）时，那个 generator 一次 `next()` 都没有过，
   * 连接会一直挂到上游自己超时。
   */
  release(): Promise<void>
}

interface RequestPayload {
  readonly body?: BodyInit
  readonly contentType?: string
}

function requestPayload(body: PreparedProviderBody): RequestPayload {
  if (body.kind === 'none') return {}
  if (body.kind === 'json') return { body: body.json, contentType: 'application/json' }
  const encoded = encodeMultipartBody(body.parts)
  return { body: encoded.bytes, contentType: encoded.contentType }
}

function header(response: Response, name: string): string | undefined {
  return response.headers.get(name) ?? undefined
}

/** Rust `declared_response_too_large`：只信 content-length，解析不出就当没声明。 */
function declaredResponseTooLarge(response: Response, limit: number): boolean {
  const declared = Number(response.headers.get('content-length'))
  return Number.isFinite(declared) && declared > limit
}

interface AbortLink {
  readonly signal: AbortSignal
  dispose(): void
}

/**
 * 把外部取消信号与整体超时合成一个内部信号。
 *
 * 不用 `AbortSignal.any` / `AbortSignal.timeout`：测试跑在 jsdom 环境里，那两个静态方法在
 * jsdom 的 `AbortSignal` 上不保证存在，而「生产能跑、测试里 undefined is not a function」是最
 * 难查的一类差异。自己接线只依赖 `AbortController` 与 `setTimeout`，两处都有。
 */
function linkedAbort(signal: AbortSignal, timeoutMs: number): AbortLink {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  if (signal.aborted) controller.abort()
  else signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  // 计时器不该把进程钉住：CLI 宿主跑完一轮就该退出，一个还没到点的 120 秒计时器会让它多挂两分钟。
  timer.unref?.()
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    },
  }
}

/** 一次响应体的读取状态。`reader` 一旦建立，`response.body` 就被锁住、只能经它取消。 */
interface BodyReadState {
  reader?: ReadableStreamDefaultReader<Uint8Array>
}

async function* streamBody(
  response: Response,
  limit: number,
  external: AbortSignal,
  link: AbortLink,
  state: BodyReadState,
): AsyncGenerator<Uint8Array, void, undefined> {
  try {
    if (!response.body) return
    const reader = response.body.getReader()
    state.reader = reader
    let total = 0
    try {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>
        try {
          chunk = await reader.read()
        } catch {
          // 读流阶段的失败在 Rust 侧是一条 `Error` 事件后收尾，不是命令级错误——响应头早就发出去
          // 了，改不回去。这里对应地抛 ModelProxyStreamError，让 M2 断连接而不是把半截响应说成完整。
          if (external.aborted) throw new ModelRequestCancelledError()
          throw new ModelProxyStreamError(MODEL_ERROR.responseInterrupted)
        }
        if (chunk.done) return
        const value = chunk.value
        total += value.byteLength
        if (total > limit) throw new ModelProxyStreamError(MODEL_ERROR.responseTooLarge)
        yield value
      }
    } finally {
      // 消费方提前 break / 抛错时，这一句负责真的把上游连接放掉。少了它，一次被放弃的响应会让
      // socket 一直挂着直到上游自己超时。
      await reader.cancel().catch(() => undefined)
    }
  } finally {
    link.dispose()
  }
}

/**
 * 发一次上游请求，拿回响应头与受限字节流。
 *
 * 失败分两类，**分界线是响应头有没有交出去**：
 *   · 交出去之前 → 本函数 reject（`模型服务请求失败` / `模型响应过大` / 取消）。调用方还能给出
 *     一个完整的失败响应。
 *   · 交出去之后 → 从 `body` 这个 generator 抛出。状态码已经写给客户端了，唯一诚实的做法是断连接。
 */
export async function sendUpstreamRequest(input: UpstreamRequestInput): Promise<UpstreamResponse> {
  const { target, apiKey, signal, fetchImpl } = input
  const link = linkedAbort(signal, input.timeoutMs ?? MODEL_REQUEST_TIMEOUT_MS)
  let response: Response
  try {
    const payload = requestPayload(input.body)
    const headers = new Headers({
      authorization: `Bearer ${apiKey}`,
      accept: 'application/json, text/event-stream',
    })
    if (payload.contentType) headers.set('content-type', payload.contentType)
    response = await fetchImpl(target.url, {
      method: target.method,
      headers,
      body: payload.body,
      // 对齐 reqwest 的 `redirect::Policy::none()`：**不跟随**重定向，把 3xx 原样交回。跟随会让
      // 一个被攻陷的上游把带着 Authorization 头的请求引到别处——Key 就是这么泄的。
      redirect: 'manual',
      signal: link.signal,
    })
  } catch (error) {
    link.dispose()
    if (signal.aborted) throw new ModelRequestCancelledError()
    // 这里刻意**不把 error 的内容带出去**：undici 的 cause 链里会出现请求的 URL 与头部摘要，
    // 而头部里有 Authorization。Rust 侧同样是 `map_err(|_| ...)` 丢掉原因。
    throw modelRequestError('upstreamFailed')
  }
  if (declaredResponseTooLarge(response, target.maxResponseBytes)) {
    await response.body?.cancel().catch(() => undefined)
    link.dispose()
    throw modelRequestError('responseTooLarge')
  }
  const state: BodyReadState = {}
  return {
    status: response.status,
    contentType: header(response, 'content-type'),
    retryAfter: header(response, 'retry-after'),
    body: streamBody(response, target.maxResponseBytes, signal, link, state),
    async release() {
      link.dispose()
      // 流已经被 generator 锁住时只能经 reader 取消；`stream.cancel()` 在锁定状态下会抛。
      if (state.reader) await state.reader.cancel().catch(() => undefined)
      else await response.body?.cancel().catch(() => undefined)
    },
  }
}
