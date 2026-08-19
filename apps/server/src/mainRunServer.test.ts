// 端到端编排测试：真起服务（永远用 `--port 0` 让系统分配，不写死端口号），
// 但浏览器打开永远经注入的 openBrowserImpl 桩——同 mainBrowserLaunch.test.ts 的纪律，
// 这里绝不能真的 spawn。

import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SERVER_CLI_USAGE } from './mainCliOptions'
import { runServerCli } from './mainRunServer'
import type { ShutdownSignal, ShutdownSignalTarget } from './mainShutdown'

/**
 * 信号挂载的假目标。**每个用例都必须传**：`runServerCli` 默认把处理器挂到真的 `process` 上，
 * 一个文件里调六次就攒六组 listener，而它的退出动作会把 vitest 自己带走。
 */
function fakeSignals(): ShutdownSignalTarget & {
  fire: (signal: ShutdownSignal) => void
  signals: () => ShutdownSignal[]
  exitCodes: () => number[]
} {
  const handlers = new Map<ShutdownSignal, () => void>()
  const codes: number[] = []
  return {
    on: (signal, listener) => handlers.set(signal, listener),
    exit: (code) => { codes.push(code) },
    fire: (signal) => { handlers.get(signal)?.() },
    signals: () => [...handlers.keys()],
    exitCodes: () => codes,
  }
}

function collectWrites(): { write: (chunk: unknown) => boolean; text: () => string } {
  const chunks: string[] = []
  return {
    write: (chunk: unknown) => {
      chunks.push(String(chunk))
      return true
    },
    text: () => chunks.join(''),
  }
}

describe('runServerCli', () => {
  const servers: Server[] = []

  afterEach(async () => {
    while (servers.length > 0) {
      const server = servers.pop()
      await new Promise<void>((resolve) => server?.close(() => resolve()))
    }
  })

  it('--help：打印用法、不建服务、不开浏览器', async () => {
    const stdout = collectWrites()
    const openBrowserImpl = vi.fn()

    const result = await runServerCli({ argv: ['--help'], stdout, openBrowserImpl, signals: fakeSignals() })

    expect(result).toBeUndefined()
    expect(stdout.text()).toBe(SERVER_CLI_USAGE)
    expect(openBrowserImpl).not.toHaveBeenCalled()
  })

  it('正常启动 + --no-open：真的在监听，打印的 URL 带 token，且不开浏览器', async () => {
    const stdout = collectWrites()
    const openBrowserImpl = vi.fn()

    const server = await runServerCli({ argv: ['--port', '0', '--no-open'], stdout, openBrowserImpl, signals: fakeSignals() })
    if (server) servers.push(server)

    expect(server).toBeDefined()
    expect(server?.listening).toBe(true)
    const boundPort = (server?.address() as AddressInfo).port

    const printed = stdout.text()
    expect(printed).toContain(`http://127.0.0.1:${boundPort}/?token=`)
    expect(printed).toContain('已跳过自动打开浏览器（--no-open）。')
    expect(openBrowserImpl).not.toHaveBeenCalled()
  })

  it('默认自动打开：openBrowserImpl 收到与打印文案里一致的 URL', async () => {
    const stdout = collectWrites()
    const openBrowserImpl = vi.fn()

    const server = await runServerCli({ argv: ['--port', '0'], stdout, openBrowserImpl, signals: fakeSignals() })
    if (server) servers.push(server)

    expect(openBrowserImpl).toHaveBeenCalledTimes(1)
    const [openedUrl] = openBrowserImpl.mock.calls[0] as [string, unknown]
    expect(stdout.text()).toContain(openedUrl)
    expect(stdout.text()).toContain('正在尝试自动打开浏览器……')
  })

  it('openBrowserImpl 失败时，onError 把提示写到 stderr，不影响 runServerCli 本身 resolve', async () => {
    const stdout = collectWrites()
    const stderr = collectWrites()
    const openBrowserImpl = vi.fn((_url: string, options?: { onError?: (error: unknown) => void }) => {
      options?.onError?.(new Error('ENOENT'))
    })

    const server = await runServerCli({ argv: ['--port', '0'], stdout, stderr, openBrowserImpl, signals: fakeSignals() })
    if (server) servers.push(server)

    expect(stderr.text()).toBe('未能自动打开浏览器，请手动访问上方地址。\n')
  })

  it('每次启动生成不同的 token', async () => {
    const stdoutA = collectWrites()
    const stdoutB = collectWrites()

    const serverA = await runServerCli({ argv: ['--port', '0', '--no-open'], stdout: stdoutA, signals: fakeSignals() })
    const serverB = await runServerCli({ argv: ['--port', '0', '--no-open'], stdout: stdoutB, signals: fakeSignals() })
    if (serverA) servers.push(serverA)
    if (serverB) servers.push(serverB)

    const tokenOf = (text: string) => /token=([A-Za-z0-9_-]+)/.exec(text)?.[1]
    const tokenA = tokenOf(stdoutA.text())
    const tokenB = tokenOf(stdoutB.text())
    expect(tokenA).toBeDefined()
    expect(tokenB).toBeDefined()
    expect(tokenA).not.toBe(tokenB)
  })

  it('启动时就把三个停止信号挂上，收到 SIGTERM 会走到退出（128 + 15）', async () => {
    const stdout = collectWrites()
    const signals = fakeSignals()

    const server = await runServerCli({
      argv: ['--port', '0', '--no-open'],
      stdout,
      signals,
      openBrowserImpl: vi.fn(),
    })
    if (server) servers.push(server)

    // 三个信号缺一个就是一条漏下 MCP 子进程的路：SIGTERM（`kill` / 服务管理器停服）、
    // SIGINT（Ctrl+C）、SIGHUP（关掉终端窗口）。
    expect(signals.signals().sort()).toEqual(['SIGHUP', 'SIGINT', 'SIGTERM'])

    signals.fire('SIGTERM')
    // dispose 是异步的：本轮微任务跑完才会退出。
    await vi.waitFor(() => expect(signals.exitCodes()).toEqual([143]))
    expect(stdout.text()).toContain('正在停止（收到 SIGTERM）')
  })

  it('--help：不装信号处理（没有 server，也就没有要清理的东西）', async () => {
    const signals = fakeSignals()

    await runServerCli({ argv: ['--help'], stdout: collectWrites(), signals })

    expect(signals.signals()).toEqual([])
  })
})
