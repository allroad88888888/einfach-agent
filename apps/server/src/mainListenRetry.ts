// 端口选择：`EADDRINUSE` 是 `listen()` 之后的**异步 error 事件**，不是同步抛出——
// 想接住它必须订阅 `'error'`，`try/catch` 包住 `server.listen(...)` 什么都接不住。
//
// 【复用同一台 `http.Server` 而不是每次重试都 new 一台】
// 实测验证过（不是猜的）：一台 `http.Server` 在收到 `'error'`（EADDRINUSE）之后，仍可以再次调用
// `.listen()` 并成功绑定到另一个端口——不需要重新 `createServer`。`createWebAgentServer()` 在
// 装配阶段就把命令路由表、认证 token 等状态闭包进了返回的 server 的请求处理器里，换一台新 server
// 等于要求调用方把这些选项原样传第二遍，纯属多余的复杂度。
//
// 【只对 EADDRINUSE 重试，其余错误直接抛出】
// `EACCES`（绑定 1024 以下端口没权限）、`EADDRNOTAVAIL`（`--host` 传了本机不存在的地址）这类错误
// 换端口换不掉——继续在下一个端口重试只是在用「看起来还在尝试」掩盖一个真正的配置问题，
// 且会把 10 次尝试全部耗光才报错，反而让人以为是端口全被占用。这类错误第一次出现就直接抛出。

import type { Server } from 'node:http'

/**
 * 默认起始端口。避开本仓库开发时最可能同时跑着的几个端口——Vite dev（5173）、
 * Vite preview（4173，`pnpm preview` 用它）——以及 3000/8000/8080 这类外部工具常用的默认值，
 * 免得 `pnpm serve` 和 `pnpm dev` 同时开着时无谓地触发一次重试。落在非特权端口范围（>1024），
 * 任何操作系统上都不需要额外权限。
 */
export const DEFAULT_START_PORT = 4765

/**
 * 默认重试次数。够用来越过「巧合占用了一两个端口」，不足以让「全部占满」这种系统性问题
 * 看起来像是在正常工作——耗光 10 次仍失败，几乎可以确定问题不在端口本身。
 */
export const DEFAULT_PORT_ATTEMPTS = 10

export interface PortRetryOptions {
  readonly host: string
  readonly startPort: number
  /** 默认 `DEFAULT_PORT_ATTEMPTS`；测试用更小的值让「耗尽」路径可控。 */
  readonly attempts?: number
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

type ListenAttemptResult = { readonly ok: true; readonly port: number } | { readonly ok: false; readonly error: unknown }

function listenOnce(server: Server, host: string, port: number): Promise<ListenAttemptResult> {
  return new Promise((resolve) => {
    const onListening = (): void => {
      server.off('error', onError)
      const address = server.address()
      // `port` 落在这里只是保底；真实监听端口以内核回报的 `address()` 为准
      // （传 0 走系统分配端口的调用方就依赖这一步）。
      const boundPort = address !== null && typeof address === 'object' ? address.port : port
      resolve({ ok: true, port: boundPort })
    }
    const onError = (error: unknown): void => {
      server.off('listening', onListening)
      resolve({ ok: false, error })
    }
    server.once('listening', onListening)
    server.once('error', onError)
    server.listen(port, host)
  })
}

/**
 * 从 `startPort` 开始尝试监听，端口被占（`EADDRINUSE`）就换下一个，直到成功或次数耗尽。
 * 成功时返回实际绑定的端口；耗尽或遇到非 `EADDRINUSE` 的错误时 reject。
 */
export async function listenWithPortRetry(server: Server, options: PortRetryOptions): Promise<number> {
  const attempts = options.attempts ?? DEFAULT_PORT_ATTEMPTS
  let lastError: unknown

  for (let offset = 0; offset < attempts; offset += 1) {
    const port = options.startPort + offset
    const result = await listenOnce(server, options.host, port)
    if (result.ok) return result.port
    if (!isErrnoException(result.error) || result.error.code !== 'EADDRINUSE') throw result.error
    lastError = result.error
  }

  throw new Error(
    `端口 ${options.startPort}-${options.startPort + attempts - 1} 均已被占用，已放弃监听。` +
      '可用 --port 指定其他起始端口。',
    { cause: lastError },
  )
}
