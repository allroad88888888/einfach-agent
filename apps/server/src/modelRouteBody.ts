// 读取 `POST /api/model/request` 的请求体：边读边数字节、超上限即停、再解析 JSON。
// ---------------------------------------------------------------------------
// 【为什么 HTTP 这条路上必须自己截断】（issue 树 findings #20，M1 交接给 M2 的那条）
// Rust 侧的 56 MiB 上限施加在 **Tauri IPC 反序列化之后**——那一刻整份载荷早就在内存里了，
// 它实际挡的是 base64 解码那步的放大，不是内存峰值。M1 的 `narrowProviderRequestEnvelope`
// 同样是「先有一个完整的 JS 值，再量它的字节数」，那是进程内注入（CLI / sidecar）那条路上的
// 最后一道。**HTTP 这条路上的第一道必须在读请求体时就落下**：不截断的话，一个 500 MiB 的 body
// 在我们看见第一个字节的语义之前就已经把内存吃光了，而这台 server 随后还要执行 shell 命令。
//
// 【上限取 56 MiB：与 M1 的信封硬顶是同一个数】
// 客户端发出的正是那份被 `JSON.stringify` 量过的信封（前端 providerWireEnvelope.ts 量的也是
// 同一个东西），所以两处用同一个数，中间不留一段「HTTP 放行、M1 再拒」的灰带。
// 代价是可预期的：一份被格式化过（带缩进空白）的 56 MiB 信封会在这里拿 413，而它的紧凑形态
// 本来能过。这是 fail-closed 的一侧，且没有任何正常客户端会那么发。
// 它是**可选项**而不是写死的墙：装配层传 `maxBodyBytes` 就能覆盖。
//
// 【为什么不用 `for await...of` 读流】（与 invokeRouteBody.ts 同一个理由，由共享 reader 兑现）
// 对 Node 的 Readable 提前 `break` 会触发迭代器的 `.return()` 进而 `destroy()` 掉这条流，而
// `IncomingMessage` 与 `ServerResponse` 共享同一条底层 socket——destroy 请求方等于把「回一条
// 413」的那次响应也一起打断，调用方只会看到连接被重置。所以共享 reader 手写 `'data'/'end'/'error'`
// 监听器：超限后**只停止累积**（内存不再增长），仍然把已经到达的字节消费掉，不去动 socket。
//
// 【与 invoke 路由的形状差异】那边解析完还要判「顶层是不是一袋键值」，因为它要把 args 逐字
// 透传给一张 `Record<string, unknown>` 的路由表。这里**不判**：信封的形状（含
// `deny_unknown_fields` 与 56 MiB 硬顶）由 M1 的 `narrowProviderRequestEnvelope` 唯一裁决，
// 在这里先判一遍只会造出第二个权威，且两处对「什么叫格式无效」的说法迟早不一致。
// 本模块只回答一个问题：这堆字节是不是合法 JSON。

import { PROVIDER_TRANSPORT_LIMITS as LIMITS } from '@einfach-agent/ai'
import type { IncomingMessage } from 'node:http'
import { readBoundedJsonBody } from './boundedJsonBody'

// Content-Type 白名单直接复用 invoke 路由那份**同一个函数**，不再抄一份。
// 它挡的是表单 CSRF（浏览器的 `<form>` 只能发三种简单 content-type，设不出 application/json），
// 是一道与 Origin 无关、机制性生效的独立防线——两条 API 路由必须逐字同款，而一条安全判据存在
// 两份副本的唯一结局是某天只改了其中一份。抽成共享模块更好，但那要动 invokeRouteBody.ts，
// 不在本卡改动面内（接线时一并做即可）。
export { hasJsonContentType } from './invokeRouteBody'

/**
 * 请求体上限，默认 56 MiB —— 与 host request envelope 共同消费
 * `PROVIDER_TRANSPORT_LIMITS.maxWireRequestBytes`，理由见文件头。
 */
export const DEFAULT_MAX_MODEL_BODY_BYTES = LIMITS.maxWireRequestBytes

export type ModelRouteBodyResult =
  /** 解析出来的 JSON 值，**未收窄**——收窄是 M1 的事。 */
  | { readonly kind: 'json', readonly value: unknown }
  | { readonly kind: 'too-large' }
  | { readonly kind: 'invalid-json' }

/**
 * 读取并解析请求体。`maxBytes` 按**实际收到的字节数**判定，不看 `Content-Length`
 * ——那个头可以缺席，也可以撒谎，真正的界限只能来自累积计数。
 *
 * 空 body 落 `invalid-json`（`JSON.parse('')` 本来就抛）：本端点的每一次调用都必须带一份信封，
 * 「没带」与「带错了」对调用方是同一个处置。
 *
 * 流上的 `error`（客户端中途断连）让 Promise **reject**，不折成某个 kind——那是传输故障，
 * 不是「body 内容不对」，交给上层统一处理。
 */
export function readModelRouteBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<ModelRouteBodyResult> {
  return readBoundedJsonBody(request, maxBytes).then((result) => {
    if (result.kind === 'empty') return { kind: 'invalid-json' }
    return result
  })
}
