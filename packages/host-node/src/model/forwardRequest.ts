// 一次受限模型请求的完整编排：收窄 → 查白名单 → 登记取消 → 备 body → 取 Key → 发出去
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/model_proxy.rs（已随 T1 删除）的 `run_provider_request`（顺序逐句对齐）。
//
// ═══ 流最终怎么出去（本域最需要说清的一件事）═══
// 桌面侧的 `model_provider_request` 有第三个参数 `events: Channel<ModelProxyEvent>`，响应体被切成
// `Chunk` 事件从那条反向通道回去；命令本身的返回值是 `()`。**Node 侧没有那条通道**：
// `HostInvoke` 的签名是 `(cmd, args) => Promise<T>`，一个 JSON 值装不下一条流，而同一张命令路由表
// 还要挂在 `POST /api/invoke/:command` 后面——那条路上返回值会被 `JSON.stringify`。
//
// 所以本卡的分工是：
//   · **本文件导出的 `forwardProviderRequest` 就是流式出口本身**。它返回响应头 + 一个
//     `AsyncGenerator<Uint8Array>`，字节原样透传，不攒、不整形。
//   · **M2（`apps/server` 的 `POST /api/model/request`）直接调它**，把 generator 往 HTTP 响应里
//     pipe。issue 树给 M2 的判据里明写「直接返回流式 body，**不进 `/api/invoke/:command`
//     的统一路由**」，说的就是这条路。
//   · 因此 `model_provider_request` / `model_chat_completions` 这两条命令**故意不出现在路由表里**
//     （见 index.ts）。路由表是 `Partial`，缺席 = 分发层报「尚未实现」；写一个把流攒完再返回的
//     handler 才是真正的错误——那会造出「看起来能流式、实际等全部生成完才吐一个字」的假象，
//     而这个假象在开发机上（响应快）根本看不出来。
//
// ═══ 取消表的账（谁登记、谁销账）═══
// `register` 在本文件，`finish` 挂在**响应流收尾**上（generator 的 finally）而不是本函数返回时
// ——本函数拿到响应头就返回了，流还在调用方手里跑，那段时间里取消必须还找得到这次请求。
// 拿到响应头之前的任何失败都在本文件里当场销账。调用方拿到响应后决定不要了，走 `release()`。

import { ModelRequestCancelledError } from './errors'
import { narrowProviderRequestEnvelope } from './requestEnvelope'
import { prepareProviderBody } from './requestBody'
import { readActiveModelCredential } from './credentials'
import { readRegisteredOpenAiCompatOrigin } from './openAiCompatEndpoint'
import { resolveProviderTarget } from './providerRoute'
import type { ProviderTarget, RegisteredProviderOrigins } from './providerRoute'
import { modelRequestRegistry, type ModelRequestRegistry } from './requestRegistry'
import { sendUpstreamRequest, type ModelFetch, type UpstreamResponse } from './upstreamRequest'
import type { NodeHostInvokeOptions } from '../hostOptions'

export interface ForwardProviderRequestDeps {
  /** 宿主装配槽。**Key 只从这里指向的配置读**（N7 的 `~/.webAgent/config.json`）。 */
  readonly options: NodeHostInvokeOptions
  /**
   * 可注入的 fetch，默认 `globalThis.fetch`。
   *
   * 本域的测试**必须**用它替掉真实网络：白名单把 URL 钉死在三家供应商的 origin 上，不注入就意味着
   * 一跑测试就真的打到线上端点、真的花用户的额度。
   */
  readonly fetchImpl?: ModelFetch
  /** 取消表，默认进程级共享实例（取消命令看的也是它）。测试传一个隔离实例。 */
  readonly registry?: ModelRequestRegistry
  /** 只给测试用的超时覆盖。 */
  readonly timeoutMs?: number
}

export interface ForwardedModelResponse {
  readonly status: number
  readonly contentType?: string
  readonly retryAfter?: string
  /**
   * 上游响应体，**逐块原样**。消费完（或抛错）时这次请求自动从取消表销账。
   *
   * 会抛两类错误：`ModelProxyStreamError`（响应过大 / 响应中断，含整体超时）与
   * `ModelRequestCancelledError`（被取消）。两类都发生在响应头已经交出去之后——状态码写出去就
   * 改不回来了，调用方唯一诚实的处理是断连接，而不是把半截响应当成一次完整的成功。
   */
  readonly body: AsyncGenerator<Uint8Array, void, undefined>
  /** 放弃这次响应：断上游、销账。拿到响应头后不打算消费时**必须**调它。 */
  release(): Promise<void>
}

/**
 * 查出这次请求可能用得上的登记式 origin（当前只有 openai-compat 一条）。
 *
 * **按 provider 分支而不是无条件读**：前三家的 origin 是常量，为它们多读一次配置文件等于给
 * 每一次 DeepSeek 请求加一次无用的磁盘 IO。分支写在这里而不是藏进 providerRoute，是因为
 * 「白名单不碰文件系统」是那张表的硬约束（它必须能被内存里穷举验证），读盘只能发生在编排层。
 *
 * 读不到就交空表下去：`resolveProviderTarget` 会把它判成目标未获允许（fail closed）。
 */
async function registeredOrigins(
  options: NodeHostInvokeOptions,
  target: ProviderTarget,
): Promise<RegisteredProviderOrigins> {
  if (target.provider !== 'openai-compat') return {}
  return { openAiCompat: await readRegisteredOpenAiCompatOrigin(options) }
}

/** 消费完就销账。`yield*` 会把调用方的提前退出原样转给上游流，让它也收尾。 */
async function* trackedBody(
  upstream: UpstreamResponse,
  registry: ModelRequestRegistry,
  requestId: string,
): AsyncGenerator<Uint8Array, void, undefined> {
  try {
    yield* upstream.body
  } finally {
    registry.finish(requestId)
  }
}

/**
 * 转发一次受限模型请求。
 *
 * `input` 是**外部输入**（HTTP 那条路上来自浏览器的 JSON），所以第一件事是收窄，不是取值。
 *
 * 各步的顺序照搬 Rust，不是可换的：先收窄信封（拿到 requestId 才能登记取消）、再查白名单
 * （目标不合法时不该占用一个 requestId）、再登记、再备 body（这一步可能很贵，登记在前才让它
 * 可取消）、最后才读 Key——**Key 是整条链上最晚出现、活得最短的东西**。
 */
export async function forwardProviderRequest(
  input: unknown,
  deps: ForwardProviderRequestDeps,
): Promise<ForwardedModelResponse> {
  const registry = deps.registry ?? modelRequestRegistry
  const fetchImpl = deps.fetchImpl ?? ((url, init) => globalThis.fetch(url, init))
  const envelope = narrowProviderRequestEnvelope(input)
  // 查表这一步现在可能先读一次配置（只有 openai-compat 会）。它仍然排在登记之前：目标不合法
  // 时不该占用一个 requestId，而这一次读的是本机的一个小 JSON，不是网络往返。
  const target = resolveProviderTarget(
    envelope.target,
    await registeredOrigins(deps.options, envelope.target),
  )
  const controller = registry.register(envelope.requestId)
  let upstream: UpstreamResponse
  try {
    const body = prepareProviderBody(envelope.body, target.bodyKind)
    // 每个可能耗时的步骤之后补一次取消检查，对齐 Rust 的 `tokio::select!` 分支：取消发生在
    // 备 body 期间时，不该再去读一次 Key、也不该再发一次上游请求。
    if (controller.signal.aborted) throw new ModelRequestCancelledError()
    const apiKey = await readActiveModelCredential(deps.options, target.provider, target.scope)
    if (controller.signal.aborted) throw new ModelRequestCancelledError()
    upstream = await sendUpstreamRequest({
      target,
      body,
      apiKey,
      signal: controller.signal,
      fetchImpl,
      timeoutMs: deps.timeoutMs,
    })
  } catch (error) {
    // 响应头还没交出去，这次请求到此为止——当场销账，否则这个 requestId 会永远占着表。
    registry.finish(envelope.requestId)
    throw error
  }
  return {
    status: upstream.status,
    contentType: upstream.contentType,
    retryAfter: upstream.retryAfter,
    body: trackedBody(upstream, registry, envelope.requestId),
    async release() {
      registry.finish(envelope.requestId)
      await upstream.release()
    },
  }
}
