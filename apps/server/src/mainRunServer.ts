// 启动编排：把参数解析、token 生成、`listen`、打印、开浏览器串起来。
//
// 本文件是「真正的副作用」那一层——同 S1 把 `createServer`（纯装配）与 `listen`（S4 的副作用）
// 分开的思路，这里把「能测的逻辑」（`mainCliOptions.ts` / `mainListenRetry.ts` /
// `mainBrowserLaunch.ts` / `mainStartupMessage.ts`，均为纯函数或接受注入依赖）与
// 「一跑就真的监听端口、真的 spawn 浏览器」的编排分开：`runServerCli` 本身仍可以被测试覆盖
// （`argv` / `stdout` / `stderr` 都可注入），只是它调用的 `openBrowser` 默认会真的 spawn——
// 所以测试永远显式传 `spawnImpl` 桩（见同目录测试文件），不依赖这层默认值。
//
// **不传 token 不是「关闭认证」**：见 `createServer.ts` 里 `token` 选项的文档。本文件因此
// 总是 `generateAuthToken()` 一次，同时喂给 `createWebAgentServer` 和打印出的 URL——这是
// token 在本进程里唯一的两个消费点，别处不应该再拼出第三份。

import type { Server } from 'node:http'
import { createWebAgentServer } from './createServer'
import { generateAuthToken } from './authToken'
import { DEFAULT_BIND_ADDRESS } from './authLoopback'
import { openBrowser } from './mainBrowserLaunch'
import { parseServerCliOptions, SERVER_CLI_USAGE } from './mainCliOptions'
import { DEFAULT_START_PORT, listenWithPortRetry } from './mainListenRetry'
import { installHostShutdown, type ShutdownSignalTarget } from './mainShutdown'
import { formatStartupMessage } from './mainStartupMessage'

/** IPv6 字面量在 URL 里必须加方括号（`::1` → `[::1]`），否则冒号会被解析成端口分隔符。 */
function formatHostForUrl(host: string): string {
  return host.includes(':') ? `[${host}]` : host
}

export interface RunServerCliOptions {
  /** 默认 `process.argv.slice(2)`。 */
  readonly argv?: readonly string[]
  readonly stdout?: Pick<NodeJS.WritableStream, 'write'>
  readonly stderr?: Pick<NodeJS.WritableStream, 'write'>
  /**
   * 透传给 `openBrowser` 的注入点，**测试必传**，避免真的 spawn 一个浏览器进程。
   * 不传时 `openBrowser` 落到真正的 `node:child_process.spawn`。
   */
  readonly openBrowserImpl?: typeof openBrowser
  /**
   * 信号处理的挂载目标，**测试必传**（同 `openBrowserImpl` 的纪律）：不传就真的挂到 `process`
   * 上，一个测试文件里调几次就攒几组 listener，而它的退出动作会把 vitest 自己杀掉。
   * 不传时落到真正的 `process`——默认必须是"真的会清理"，见 `mainShutdown.ts`。
   */
  readonly signals?: ShutdownSignalTarget
}

/**
 * 解析参数、起服务、打印、（可选）开浏览器。`--help` 打印用法后直接返回 `undefined`，不做其余
 * 任何事、也不创建 server。
 *
 * 返回已在监听的 `Server`（`--help` 时返回 `undefined`）——`main.ts` 会忽略这个返回值，
 * 让进程一直跑到 `Ctrl+C`；测试用它在用例结束后 `close()`，避免端口/句柄跨用例泄漏。
 */
export async function runServerCli(options: RunServerCliOptions = {}): Promise<Server | undefined> {
  const stdout = options.stdout ?? process.stdout
  const stderr = options.stderr ?? process.stderr
  const openBrowserImpl = options.openBrowserImpl ?? openBrowser
  const cli = parseServerCliOptions(options.argv ?? process.argv.slice(2))

  if (cli.help) {
    stdout.write(SERVER_CLI_USAGE)
    return undefined
  }

  // 信号处理**先于 server 装配**：关停钩子的登记面要在 `createWebAgentServer` 里就位
  // （它随后交给 host-node 的 `registerHostDisposer` 槽），而且此后任何一刻收到 SIGTERM
  // 都已经有人接着。见 `mainShutdown.ts`。
  const shutdown = installHostShutdown({
    target: options.signals ?? process,
    notice: (text) => { stdout.write(text) },
  })

  // 每次启动生成一枚新 token，只喂给这两处：这里传给 server，下面拼进打印的 URL。
  const token = generateAuthToken()
  const server = createWebAgentServer({ token, registerHostDisposer: shutdown.registerHostDisposer })
  const host = cli.host ?? DEFAULT_BIND_ADDRESS
  const port = await listenWithPortRetry(server, { host, startPort: cli.port ?? DEFAULT_START_PORT })

  const url = `http://${formatHostForUrl(host)}:${port}/?token=${token}`
  stdout.write(formatStartupMessage({ url, willOpen: cli.open }))

  if (cli.open) {
    openBrowserImpl(url, {
      onError: () => {
        // 只提示「打不开」，不再重复打印 URL——上面 formatStartupMessage 已经打过一次，
        // token 不该有第三个出口。
        stderr.write('未能自动打开浏览器，请手动访问上方地址。\n')
      },
    })
  }

  return server
}
