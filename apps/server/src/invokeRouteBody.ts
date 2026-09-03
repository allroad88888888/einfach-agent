// 读取并解析 `/api/invoke/:command` 的 POST body。
// ---------------------------------------------------------------------------
// 两件事、各自独立可测：
//   ① Content-Type 白名单（`hasJsonContentType`）——见下方那段关于表单 CSRF 的说明；
//   ② 复用 `boundedJsonBody` 读流，再校验顶层 JSON 形状（`readInvokeRouteBody`）——
//      `Content-Length` 可以缺席或撒谎，真正的界限只能来自累积计数，不能只查一次头就放行；
//      handler 期望的是「一袋键值」，数组/字符串/数字/布尔/null 都不是。
//
// 【为什么不用 `for await...of` 读流】
// 对 Node 的 Readable 提前 `break` 出 `for await` 循环会触发迭代器的 `.return()`，那会连带
// `destroy()` 掉这个 stream——而 `IncomingMessage` 与 `ServerResponse` 共享同一条底层 socket，
// destroy 请求方等于把回 413 的这次响应也一起打断，调用方只会看到连接被重置而不是一个 JSON
// 错误体。所以共享 reader 手写 `'data'/'end'/'error'` 监听器：超限后只停止**累积**，
// 内存不会失控，但仍然把已经到达内核缓冲区的字节消费掉，不去动 socket 本身。

import type { IncomingMessage } from 'node:http'
import { readBoundedJsonBody } from './boundedJsonBody'

/**
 * `Content-Type` 是否为 `application/json`（允许可选的 `; charset=...` 参数，大小写不敏感）。
 *
 * 【这不是「校验 body 内容」，是防表单 CSRF 的一道独立防线】
 * body 是不是真的合法 JSON 由 `JSON.parse` 自己认；这里要挡的是另一件事——浏览器的 `<form>`
 * 元素只能把请求的 `Content-Type` 设成 `application/x-www-form-urlencoded` / `multipart/form-data`
 * / `text/plain` 三者之一（这是浏览器强制的白名单，页面上的 JS 无法覆盖表单提交这条路径的限制），
 * **设不出 `application/json`**。要求这个头，等于让一次表单发起的跨站 POST 连请求都发不对，
 * 而且这条防线**不依赖 `Origin` 头是否存在**——S2 对没带 `Origin` 的请求是放行的，那正是表单
 * 提交这类「浏览器不一定会带 Origin」的请求可能溜过 Origin 校验的缺口，这里补上。
 * 代价是调用方必须显式带上这个头（`curl` 要多写一个 `-H 'content-type: application/json'`），
 * 换来的是一条不依赖约定、机制性生效的额外防线。
 */
export function hasJsonContentType(request: IncomingMessage): boolean {
  const header = request.headers['content-type']
  if (typeof header !== 'string') return false
  // 只取 `;` 前的媒体类型，忽略 `charset=utf-8` 之类的参数；大小写不敏感。
  const mediaType = header.split(';', 1)[0]?.trim().toLowerCase()
  return mediaType === 'application/json'
}

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
