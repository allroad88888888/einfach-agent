// 把上游的字节流 pipe 进 HTTP 响应，并让客户端断开真的中断上游。
// ---------------------------------------------------------------------------
// 这一层只有两件事，但两件都容易写成「看着能跑、实际漏」的样子：
//
// ═══ ① 客户端走了，上游必须跟着停 ═══
// 浏览器关标签页 / 用户点「停止」→ 我们这条响应的 socket 被断 → `response` 触发 `'close'`。
// 判据是 **`close` 且 `writableEnded === false`**：`close` 在正常收尾时同样会来，只有
// `writableEnded` 能分开「我们写完了」与「对方先走了」。（这与 M1 在假上游那头判断「上游是不是
// 真的被中断了」用的是同一条判据，两边对称。）
//
// 断开之后**不能等下一个 chunk 再发现**：模型在思考时可能几十秒不吐一个字节，那段时间里循环
// 卡在 `await` 上，检查一个布尔标记根本轮不到执行。所以 `close` 监听器要**主动**去放上游。
//
// 放的方式有两种，对应「这次请求走到哪一步了」：
//   · 已经拿到响应头（`adopt()` 过）→ `forwarded.release()`：cancel 掉上游响应体的 reader，
//     undici 随即销毁那条连接，上游侧观察到的是请求被中止。
//   · **还没拿到响应头** → 手里根本没有可 release 的对象，`forwardProviderRequest` 还悬在
//     「等上游回响应头」上（最长 120 秒）。这一段只有一个把手：**按 requestId 在飞请求表上取消**
//     ——与 `cancel_model_provider_request` 命令用的是同一张表、同一个动作。少了它，用户关掉标签页
//     之后上游那次生成还会继续跑到超时，而这条路径恰恰是「模型正在思考、还没吐第一个字」，
//     也就是用户最可能中途放弃的那几十秒。
// 两种都由同一个 `close` 监听器发起，中间没有窗口：`adopt()` 之前断开的，由 `adopt()` 补一次
// release（那时 generator 一次都没被消费过，它的 `finally` 不会跑，release 是唯一的销账口）。
//
// ═══ ② 背压 ═══
// `response.write()` 返回 false 表示内核缓冲区满了，此时继续写只会在 Node 的内存里排队。
// 上游（模型）比客户端快是常态（本机回环 vs. 浏览器渲染），不等 `'drain'` 就等于把整条响应
// 攒进内存——那正是「流式」这两个字要避免的事。等待期间客户端断开时 `drain()` 立刻返回，
// 由调用方去看 `gone`，不会永远挂在一个再也不会来的事件上。
//
// ═══ 不发 content-length，也不合并 chunk ═══
// 响应长度事先不知道（就是不知道，不是懒得算），所以走 chunked，Node 在没有 content-length 时
// 自动这么做。`flushHeaders()` 让响应头在第一个 chunk 之前就出去——M3 那边 `fetch` 是在响应头
// 到达时 resolve 的，压着头等于把「模型开始回话」推迟到第一个 token。
// chunk 的边界原样保留，一个字节都不重新编码（SSE 的语义带在字节边界与空行上）。

import type { ServerResponse } from 'node:http'
import type { ForwardedModelResponse } from '@einfach-agent/host-node'

export interface ClientWatch {
  /** 客户端是否在我们写完之前就断开了。 */
  readonly gone: boolean
  /**
   * 认领这次上游响应：从此「客户端断开」会立刻放掉它。
   * 若断开**已经发生**，本调用当场补一次 release——那正是 M1 点名的漏：拿到响应头却一次都不
   * 消费时，generator 的 `finally` 根本不会跑，在飞请求表会留下一条永远销不掉的账。
   */
  adopt(forwarded: ForwardedModelResponse): void
  /** 等一次 `'drain'`；客户端已经走了就立刻返回。 */
  drain(): Promise<void>
  dispose(): void
}

/** 放弃一次上游响应。这里吞掉异常是刻意的：它跑在事件回调里，没有能接住它的调用栈。 */
function releaseQuietly(forwarded: ForwardedModelResponse): void {
  void forwarded.release().catch(() => undefined)
}

/** 在飞请求表里本模块只用到 `cancel` 这一件事；结构化地收窄，免得为一个类型名去 import 一圈。 */
export interface CancellableModelRequests {
  cancel(requestId: string): boolean
}

/**
 * 按 requestId 取消一次还没拿到响应头的转发——与 `cancel_model_provider_request` 命令**同一张表、
 * 同一个动作**。
 *
 * 这是本模块唯一一处读信封字段的地方，且只读一个键名：**不做校验**。合法性由 M1 的
 * `validate_model_request_id` 唯一裁决（`cancel` 自己会对格式非法的 id 抛错，这里咽掉——那份
 * 信封本来也会在转发时被同一条判据拒掉）。在这里补一份校验只会造出第二个权威。
 */
export function cancelInFlightModelRequest(
  registry: CancellableModelRequests,
  envelope: unknown,
): void {
  if (typeof envelope !== 'object' || envelope === null) return
  const requestId = (envelope as { requestId?: unknown }).requestId
  if (typeof requestId !== 'string') return
  try {
    registry.cancel(requestId)
  } catch {
    // id 格式非法：这次转发本来就会被拒，没有需要取消的东西。
  }
}

/**
 * 盯住这条响应的连接状态。**必须在调用 `forwardProviderRequest` 之前就装上**——上游握手期间
 * 客户端就可能走掉，晚装一步那段时间的断开就没人看见。
 *
 * `abandonUpstream` 是「还没拿到响应头就断开」那条路径上的唯一把手（见文件头）。它只在
 * `adopt()` 之前的断开里被调用：拿到响应头之后 `release()` 更直接，也更快。
 */
export function watchClientConnection(
  response: ServerResponse,
  abandonUpstream: () => void,
): ClientWatch {
  let gone = false
  let adopted: ForwardedModelResponse | undefined
  let wake: (() => void) | undefined

  const onClose = () => {
    // 正常收尾也会触发 close；`writableEnded` 是唯一的分界。
    if (response.writableEnded) return
    gone = true
    wake?.()
    if (adopted) releaseQuietly(adopted)
    else abandonUpstream()
  }
  response.on('close', onClose)

  return {
    get gone() {
      return gone
    },
    adopt(forwarded) {
      adopted = forwarded
      if (gone) releaseQuietly(forwarded)
    },
    drain() {
      if (gone) return Promise.resolve()
      return new Promise<void>((resolve) => {
        const settle = () => {
          response.off('drain', settle)
          wake = undefined
          resolve()
        }
        wake = settle
        response.on('drain', settle)
      })
    },
    dispose() {
      response.off('close', onClose)
    },
  }
}

/** 上游响应头原样落到我们的响应上。**只有 M1 交出来的这三个**，与桌面通道的 `response` 事件同形。 */
function writeUpstreamHead(response: ServerResponse, forwarded: ForwardedModelResponse): void {
  response.statusCode = forwarded.status
  if (forwarded.contentType) response.setHeader('content-type', forwarded.contentType)
  if (forwarded.retryAfter) response.setHeader('retry-after', forwarded.retryAfter)
  // 与 httpReply.ts 的两条同款：模型响应绝不该被任何一级缓存留下，也不该被浏览器嗅探类型。
  response.setHeader('cache-control', 'no-store')
  response.setHeader('x-content-type-options', 'nosniff')
  response.flushHeaders()
}

/**
 * 把 `forwarded.body` 逐块写进响应。
 *
 * 抛出的错误一律来自 generator（`ModelProxyStreamError` / `ModelRequestCancelledError`），且
 * **一定发生在响应头交出去之后**——调用方据此断连，不改状态码。
 *
 * 提前 `return` 是有意的写法：从 `for await` 里退出会调用 generator 的 `.return()`，
 * M1 的 `trackedBody` / `streamBody` 的 `finally` 因此照常跑到（cancel 上游 reader、销账）。
 */
export async function pipeModelResponse(
  forwarded: ForwardedModelResponse,
  response: ServerResponse,
  watch: ClientWatch,
): Promise<void> {
  // 客户端在上游握手期间就走了：连响应头都不必写。
  if (watch.gone) return
  writeUpstreamHead(response, forwarded)
  for await (const chunk of forwarded.body) {
    if (watch.gone) return
    if (!response.write(chunk)) await watch.drain()
  }
  if (watch.gone) return
  response.end()
}
