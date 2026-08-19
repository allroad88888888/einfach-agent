// 测试脚手架：起一台只挂了 invoke handler 的真实 server。
// ---------------------------------------------------------------------------
// 不复用 `testServer.testHarness.ts`：那边起的是完整 `createWebAgentServer()`，而本卡的路由
// 还没接进 `requestRouter.ts`（S2/S3 并行，接线由主会话在两边验收后统一做），此刻调用它测不到
// 这个 handler。这里另起一台裸 `http.Server`，只挂 `createInvokeRouteHandler` 本身，
// 并补一个等价于 `requestRouter.ts` 外层 try/catch 的最小兜底——好让「非 NodeHostCommandError
// 的异常应当重抛给外层收成 500」这条行为在裸 server 上也能被测到，而不是把测试进程炸掉。
//
// `agent: false`：Node 的全局 agent 默认开 keep-alive，连接不关会让 `server.close()` 一直等，
// 表现为用例超时而不是失败（同样的理由见 testServer.testHarness.ts）。

import { once } from 'node:events'
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createInvokeRouteHandler, isInvokeRoutePath, type InvokeRouteOptions } from './invokeRoute'
import { requestPathname } from './requestPathname'

export interface InvokeRouteTestServer {
  readonly port: number
  close(): Promise<void>
}

export async function startInvokeRouteTestServer(options: InvokeRouteOptions): Promise<InvokeRouteTestServer> {
  const handler = createInvokeRouteHandler(options)
  const server = createServer((request, response) => {
    void (async () => {
      const pathname = requestPathname(request.url)
      if (!isInvokeRoutePath(pathname)) {
        response.statusCode = 404
        response.end()
        return
      }
      try {
        await handler(request, response, pathname)
      } catch (error) {
        if (!response.headersSent) {
          response.statusCode = 500
          response.end(String(error))
        } else {
          response.destroy()
        }
      }
    })()
  })
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

export interface InvokeRouteProbeResult {
  readonly status: number
  readonly headers: IncomingHttpHeaders
  readonly body: string
}

/**
 * 发一条原样的请求。`body` 不传时直接结束（无正文，用于测「命令不需要参数」与「完全没有
 * body」两条路径）；传字符串时按 utf8 写入。
 */
export async function sendInvokeRequest(
  port: number,
  method: string,
  path: string,
  body?: string,
  headers: Record<string, string> = {},
): Promise<InvokeRouteProbeResult> {
  const request = httpRequest({ host: '127.0.0.1', port, path, method, agent: false, headers })
  if (body === undefined) request.end()
  else request.end(body, 'utf8')
  const [response] = (await once(request, 'response')) as [IncomingMessage]
  const chunks: Buffer[] = []
  for await (const chunk of response) chunks.push(Buffer.from(chunk as Buffer))
  return {
    status: response.statusCode ?? 0,
    headers: response.headers,
    body: Buffer.concat(chunks).toString('utf8'),
  }
}
