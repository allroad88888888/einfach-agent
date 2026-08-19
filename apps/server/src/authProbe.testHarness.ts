// 认证用例专用的请求脚手架：与 `testServer.testHarness.ts` 的 `probe` 同形，但**能设请求头**。
//
// 为什么不去给共享的 `probe` 加一个参数：那个文件同时被 S3 的 invoke 用例使用，两张卡并行时改它
// 就是一次必然的冲突。认证是唯一需要逐条构造 `Authorization` / `Origin` / `Host` 的地方，
// 单独一个 20 行的发包器比协调改共享文件便宜得多。
//
// 沿用共享脚手架的两条理由（不重复解释，见那边的文件头）：`http.request({ path })` 把字符串逐字
// 写进请求行、不做 WHATWG 归一；`agent: false` 免得 keep-alive 让 `server.close()` 一直等下去。

import { once } from 'node:events'
import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
} from 'node:http'

export interface AuthProbeOptions {
  readonly method?: string
  /**
   * 追加/覆盖请求头。**`host` 不传时由 Node 按 `host:port` 自动填**，也就是浏览器与 curl 的真实
   * 行为；要模拟 DNS rebinding 就显式传一个别的值。
   */
  readonly headers?: OutgoingHttpHeaders
}

export interface AuthProbeResult {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly body: string
}

export async function authProbe(
  port: number,
  requestTarget: string,
  options: AuthProbeOptions = {},
): Promise<AuthProbeResult> {
  const request = httpRequest({
    host: '127.0.0.1',
    port,
    path: requestTarget,
    method: options.method ?? 'GET',
    headers: options.headers,
    agent: false,
  })
  request.end()
  const [response] = await once(request, 'response') as [IncomingMessage]
  const chunks: Buffer[] = []
  for await (const chunk of response) chunks.push(Buffer.from(chunk as Buffer))
  return {
    status: response.statusCode ?? 0,
    headers: response.headers,
    body: Buffer.concat(chunks).toString('utf8'),
  }
}

/** 带上有效 token 的请求头，测「正常调用方」那一路。 */
export function bearer(token: string): OutgoingHttpHeaders {
  return { authorization: `Bearer ${token}` }
}
