// 端到端编排测试：真起服务（永远用 `--port 0` 让系统分配，不写死端口号），
// 但浏览器打开永远经注入的 openBrowserImpl 桩——同 mainBrowserLaunch.test.ts 的纪律，
// 这里绝不能真的 spawn。

import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SERVER_CLI_USAGE } from './mainCliOptions'
import { runServerCli } from './mainRunServer'

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

    const result = await runServerCli({ argv: ['--help'], stdout, openBrowserImpl })

    expect(result).toBeUndefined()
    expect(stdout.text()).toBe(SERVER_CLI_USAGE)
    expect(openBrowserImpl).not.toHaveBeenCalled()
  })

  it('正常启动 + --no-open：真的在监听，打印的 URL 带 token，且不开浏览器', async () => {
    const stdout = collectWrites()
    const openBrowserImpl = vi.fn()

    const server = await runServerCli({ argv: ['--port', '0', '--no-open'], stdout, openBrowserImpl })
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

    const server = await runServerCli({ argv: ['--port', '0'], stdout, openBrowserImpl })
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

    const server = await runServerCli({ argv: ['--port', '0'], stdout, stderr, openBrowserImpl })
    if (server) servers.push(server)

    expect(stderr.text()).toBe('未能自动打开浏览器，请手动访问上方地址。\n')
  })

  it('每次启动生成不同的 token', async () => {
    const stdoutA = collectWrites()
    const stdoutB = collectWrites()

    const serverA = await runServerCli({ argv: ['--port', '0', '--no-open'], stdout: stdoutA })
    const serverB = await runServerCli({ argv: ['--port', '0', '--no-open'], stdout: stdoutB })
    if (serverA) servers.push(serverA)
    if (serverB) servers.push(serverB)

    const tokenOf = (text: string) => /token=([A-Za-z0-9_-]+)/.exec(text)?.[1]
    const tokenA = tokenOf(stdoutA.text())
    const tokenB = tokenOf(stdoutB.text())
    expect(tokenA).toBeDefined()
    expect(tokenB).toBeDefined()
    expect(tokenA).not.toBe(tokenB)
  })
})
