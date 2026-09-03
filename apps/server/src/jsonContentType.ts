// 判断请求是否声明 JSON media type。
//
// 这不是 body 内容校验，而是表单 CSRF 的独立防线：浏览器 `<form>` 只能提交
// `application/x-www-form-urlencoded`、`multipart/form-data` 或 `text/plain`，不能将
// Content-Type 设为 `application/json`。这条判据不依赖 Origin 头是否存在。

import type { IncomingMessage } from 'node:http'

/** 只接受 `application/json`，允许参数且大小写不敏感。 */
export function hasJsonContentType(request: IncomingMessage): boolean {
  const header = request.headers['content-type']
  if (typeof header !== 'string') return false
  const mediaType = header.split(';', 1)[0]?.trim().toLowerCase()
  return mediaType === 'application/json'
}
