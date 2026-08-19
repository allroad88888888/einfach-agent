// 测试脚手架：起一台真实监听的 server，并用 `node:http` 客户端发**原样**的请求行。
//
// 为什么不用 `fetch`：本卡最要紧的用例是「百分号编码的穿越路径」，而 `fetch` 收的是 URL，
// WHATWG URL 解析会把明文 `../` 规范化掉、也可能改写请求目标。`http.request({ path })` 把字符串
// 逐字写进请求行，测的才是 handler 真正会收到的东西。
//
// `agent: false`：Node 的全局 agent 默认开 keep-alive，连接不关会让 `server.close()` 一直等下去，
// 表现为用例超时而不是失败——排查成本远高于这一行。

import { once } from 'node:events'
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createWebAgentServer, type WebAgentServerOptions } from './createServer'

export interface TestServerHandle {
  readonly port: number
  close(): Promise<void>
}

export async function startTestServer(options: WebAgentServerOptions = {}): Promise<TestServerHandle> {
  // 默认吞掉内部错误日志：用例里没有「预期外异常」时它一条都不会响，有的话由用例自己传收集器。
  const server = createWebAgentServer({ onInternalError: () => {}, ...options })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  return {
    port,
    close: async () => {
      server.close()
      await once(server, 'close')
    },
  }
}

export interface ProbeResult {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly body: string
}

/** `requestTarget` 原样进请求行，不做任何规范化。 */
export async function probe(port: number, requestTarget: string, method = 'GET'): Promise<ProbeResult> {
  const request = httpRequest({ host: '127.0.0.1', port, path: requestTarget, method, agent: false })
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
