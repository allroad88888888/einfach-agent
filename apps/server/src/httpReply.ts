// 回包小工具：把「状态码 + 内容类型 + 正文」写成一条完整响应。
//
// 单独成文件的理由：health、静态托管、提示页、API 兜底四处都要回包，而它们对**响应头**的要求
// 是同一套（下面三条），散着写迟早有一处漏掉其中一条，而漏掉是静默的。
//
// 三条共同要求：
// ① `content-length` 一律显式给，且**按字节数**（`Buffer.byteLength`）而不是字符串 `.length`
//    ——中文提示页里一个汉字 3 字节，用字符数会让浏览器把响应截断在半个字符上。
// ② `cache-control: no-store`。本地自托管的核心用法是「改了代码 → 重新 build → 刷新页面」，
//    任何一级缓存都会把「改了没生效」变成最难查的那类问题；localhost 上省下的那点带宽不值这个价。
// ③ `x-content-type-options: nosniff`。我们服务的是用户自己 build 出来的产物，浏览器再去
//    嗅探内容类型只会制造「.txt 被当 HTML 执行」这类惊喜。
//
// HEAD 由 `includeBody: false` 表达：响应头（含 `content-length`）与 GET 逐字相同，只是不写正文
// ——这是 RFC 要求的语义，也让「HEAD 探活」能拿到与 GET 一致的元信息。

import type { ServerResponse } from 'node:http'

export interface ReplyOptions {
  /** HEAD 请求传 false：头部照发（含真实 content-length），正文不写。默认 true。 */
  readonly includeBody?: boolean
}

function reply(
  response: ServerResponse,
  statusCode: number,
  contentType: string,
  body: Buffer,
  options: ReplyOptions = {},
): void {
  response.statusCode = statusCode
  response.setHeader('content-type', contentType)
  response.setHeader('content-length', body.byteLength)
  response.setHeader('cache-control', 'no-store')
  response.setHeader('x-content-type-options', 'nosniff')
  if (options.includeBody === false) {
    response.end()
    return
  }
  response.end(body)
}

export function replyJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
  options?: ReplyOptions,
): void {
  reply(response, statusCode, 'application/json; charset=utf-8', Buffer.from(JSON.stringify(payload), 'utf8'), options)
}

export function replyText(
  response: ServerResponse,
  statusCode: number,
  text: string,
  options?: ReplyOptions,
): void {
  reply(response, statusCode, 'text/plain; charset=utf-8', Buffer.from(text, 'utf8'), options)
}

export function replyHtml(
  response: ServerResponse,
  statusCode: number,
  html: string,
  options?: ReplyOptions,
): void {
  reply(response, statusCode, 'text/html; charset=utf-8', Buffer.from(html, 'utf8'), options)
}

export function replyAsset(
  response: ServerResponse,
  contentType: string,
  body: Buffer,
  options?: ReplyOptions,
): void {
  reply(response, 200, contentType, body, options)
}
