// 把校验过的分片编码成 `multipart/form-data` 的字节
// ---------------------------------------------------------------------------
// 对应 Rust 侧 `reqwest::multipart::Form`（那边由 reqwest 负责编码，Node 侧没有等价的现成件，
// 所以自己编）。**只做编码**：分片的名字、文件名、content-type、大小是否合法，全部在
// requestBody.ts 判完了，这里假定入参已经合规。
//
// 【为什么不用 `FormData` + 交给 fetch 自己编】看起来省事，实际是个会在测试里看不见的坑：
// 测试跑在 vitest 的 jsdom 环境里，`globalThis.FormData` 是 **jsdom 的**实现；生产跑在纯 Node
// 里，`fetch` 是 undici 的实现，而 undici 判断 body 是不是表单用的是**自己那个类**的品牌检查。
// 把 jsdom 的 FormData 交给 undici，它不认，会退化成把对象 `String()` 成 `[object FormData]`
// 发出去——上游收到一个 12 字节的垃圾 body，返回一条格式错误，而本地测试全绿。自己编字节没有
// 这一层环境依赖，顺带还让「发出去的到底是什么」在测试里逐字可断言。
//
// 【boundary 用随机数，不扫描内容】128 位随机前缀撞上正文的概率可以忽略，reqwest 同样是这么做的。
// 扫描全部分片内容来挑一个不冲突的 boundary 要把所有文件字节再过一遍，对 20 MiB 的上传不划算。

import { randomBytes } from 'node:crypto'
import type { PreparedMultipartPart } from './requestBody'

const CRLF = '\r\n'

export interface EncodedMultipartBody {
  /**
   * 类型实参写死 `ArrayBuffer` 不是装饰：`fetch` 的 `BodyInit` 收的是
   * `ArrayBufferView<ArrayBuffer>`，而裸写 `Uint8Array` 默认是 `Uint8Array<ArrayBufferLike>`
   * （可能是 SharedArrayBuffer 撑的），两者不兼容，直接交给 fetch 会在 `pnpm build` 报 TS2322。
   */
  readonly bytes: Uint8Array<ArrayBuffer>
  /** 带 boundary 参数的完整 content-type，调用方原样放进请求头。 */
  readonly contentType: string
}

/** reqwest 的 `Part::file_name` 同款转义：`\` 与 `"` 加反斜杠。 */
function escapeHeaderQuoted(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function randomBoundary(): string {
  return `------------------------web-agent${randomBytes(16).toString('hex')}`
}

function partHeader(part: PreparedMultipartPart): string {
  const disposition = `Content-Disposition: form-data; name="${escapeHeaderQuoted(part.name)}"`
  if (part.kind === 'text') return `${disposition}${CRLF}${CRLF}`
  return [
    `${disposition}; filename="${escapeHeaderQuoted(part.fileName)}"`,
    `Content-Type: ${part.contentType}`,
    '',
    '',
  ].join(CRLF)
}

/**
 * 编码成一整块字节。
 *
 * 一次性拼成一个 Buffer 而不是流式产出：分片总量已经被 requestBody.ts 限在 40 MiB 以内，而
 * 流式 body 在 undici 上要求 `duplex: 'half'` 且不能自动补 content-length，换来的只是复杂度。
 *
 * `boundary` 可注入只为测试能断言逐字节输出；生产路径永远用随机值。
 */
export function encodeMultipartBody(
  parts: readonly PreparedMultipartPart[],
  boundary: string = randomBoundary(),
): EncodedMultipartBody {
  const chunks: Uint8Array[] = []
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}${CRLF}${partHeader(part)}`, 'utf8'))
    chunks.push(part.kind === 'text' ? Buffer.from(part.value, 'utf8') : part.bytes)
    chunks.push(Buffer.from(CRLF, 'utf8'))
  }
  chunks.push(Buffer.from(`--${boundary}--${CRLF}`, 'utf8'))
  return {
    bytes: new Uint8Array(Buffer.concat(chunks)),
    contentType: `multipart/form-data; boundary=${boundary}`,
  }
}
