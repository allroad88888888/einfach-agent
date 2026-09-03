// 读取并解析 `/api/invoke/:command` 的 POST body 为命令参数对象。
// `Content-Length` 可以缺席或撒谎，真正的界限只能来自累积计数；handler 期望的是「一袋键值」，
// 数组/字符串/数字/布尔/null 都不是。
//
// 【为什么不用 `for await...of` 读流】
// 对 Node 的 Readable 提前 `break` 出 `for await` 循环会触发迭代器的 `.return()`，那会连带
// `destroy()` 掉这个 stream——而 `IncomingMessage` 与 `ServerResponse` 共享同一条底层 socket，
// destroy 请求方等于把回 413 的这次响应也一起打断，调用方只会看到连接被重置而不是一个 JSON
// 错误体。所以共享 reader 手写 `'data'/'end'/'error'` 监听器：超限后只停止**累积**，
// 内存不会失控，但仍然把已经到达内核缓冲区的字节消费掉，不去动 socket 本身。

import type { IncomingMessage } from 'node:http'
import { readBoundedJsonBody } from './boundedJsonBody'

export type InvokeRouteBodyResult =
  | { readonly kind: 'empty' }
  | { readonly kind: 'object', readonly value: Record<string, unknown> }
  | { readonly kind: 'too-large' }
  | { readonly kind: 'invalid-json' }
  | { readonly kind: 'not-object' }

/**
 * 读取并解析 body。`maxBytes` 是硬上限，按**实际收到的字节数**判定，不看 `Content-Length`。
 * 空 body（长度为 0）算作 `empty`——命令没有参数时（如 `get_user_home_dir`）调用方本来就不必
 * 发正文，让它落到「当作 `{}`」而不是 `invalid-json`。
 *
 * 流上的 `error` 事件（例如客户端中途断连）让返回的 Promise **reject**，不折成某个 `kind`——
 * 那是一次意料之外的传输故障，不是「body 内容不对」，交给调用方（`requestRouter.ts` 现有的
 * 外层 try/catch）统一收成 500，与其余未预期异常同一个去处。
 */
export function readInvokeRouteBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<InvokeRouteBodyResult> {
  return readBoundedJsonBody(request, maxBytes).then((result) => {
    if (result.kind !== 'json') return result
    const parsed = result.value
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { kind: 'not-object' }
    }
    return { kind: 'object', value: parsed as Record<string, unknown> }
  })
}
