// 全部用例都必须注入 spawnImpl 桩，绝不能让测试真的打开一个浏览器进程。

import { EventEmitter } from 'node:events'
import type { SpawnOptions } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { openBrowser, resolveBrowserLaunchCommand } from './mainBrowserLaunch'

const URL_WITH_TOKEN = 'http://127.0.0.1:4765/?token=abc123'

describe('resolveBrowserLaunchCommand（纯函数，按平台选命令）', () => {
  it('darwin 用 open', () => {
    expect(resolveBrowserLaunchCommand(URL_WITH_TOKEN, 'darwin')).toEqual({
      command: 'open',
      args: [URL_WITH_TOKEN],
    })
  })

  it('win32 经 cmd /c start，带空标题占位，且要求 verbatim 参数', () => {
    const result = resolveBrowserLaunchCommand(URL_WITH_TOKEN, 'win32')
    expect(result.command).toBe('cmd')
    expect(result.args).toEqual(['/c', 'start', '""', URL_WITH_TOKEN])
    expect(result.spawnOptions).toEqual({ windowsVerbatimArguments: true })
  })

  it('linux 用 xdg-open', () => {
    expect(resolveBrowserLaunchCommand(URL_WITH_TOKEN, 'linux')).toEqual({
      command: 'xdg-open',
      args: [URL_WITH_TOKEN],
    })
  })

  it('其余类 unix 平台同样落到 xdg-open', () => {
    expect(resolveBrowserLaunchCommand(URL_WITH_TOKEN, 'freebsd').command).toBe('xdg-open')
  })
})

// ---- openBrowser：假 spawnImpl，永不真的 spawn ----

function fakeChild() {
  const emitter = new EventEmitter()
  return Object.assign(emitter, { unref: vi.fn() })
}

describe('openBrowser（注入 spawnImpl，不触碰真实进程）', () => {
  it('按 resolveBrowserLaunchCommand 的结果调用 spawnImpl，stdio 忽略、detached', () => {
    const child = fakeChild()
    const spawnImpl = vi.fn().mockReturnValue(child)

    openBrowser(URL_WITH_TOKEN, { platform: 'darwin', spawnImpl: spawnImpl as never })

    expect(spawnImpl).toHaveBeenCalledTimes(1)
    const [command, args, options] = spawnImpl.mock.calls[0] as [string, string[], SpawnOptions]
    expect(command).toBe('open')
    expect(args).toEqual([URL_WITH_TOKEN])
    expect(options).toMatchObject({ stdio: 'ignore', detached: true })
    expect(child.unref).toHaveBeenCalledTimes(1)
  })

  it('win32 的 spawnOptions（windowsVerbatimArguments）与默认选项合并', () => {
    const child = fakeChild()
    const spawnImpl = vi.fn().mockReturnValue(child)

    openBrowser(URL_WITH_TOKEN, { platform: 'win32', spawnImpl: spawnImpl as never })

    const [, , options] = spawnImpl.mock.calls[0] as [string, string[], SpawnOptions]
    expect(options).toMatchObject({ stdio: 'ignore', detached: true, windowsVerbatimArguments: true })
  })

  it('子进程 emit error（命令不存在等）：onError 收到，不抛出', () => {
    const child = fakeChild()
    const spawnImpl = vi.fn().mockReturnValue(child)
    const onError = vi.fn()

    expect(() => openBrowser(URL_WITH_TOKEN, { platform: 'linux', spawnImpl: spawnImpl as never, onError })).not.toThrow()

    const error = new Error('spawn xdg-open ENOENT')
    child.emit('error', error)
    expect(onError).toHaveBeenCalledWith(error)
  })

  it('spawnImpl 本身同步抛出：onError 收到，不向上抛', () => {
    const onError = vi.fn()
    const thrown = new Error('boom')
    const spawnImpl = vi.fn(() => {
      throw thrown
    })

    expect(() => openBrowser(URL_WITH_TOKEN, { platform: 'linux', spawnImpl: spawnImpl as never, onError })).not.toThrow()
    expect(onError).toHaveBeenCalledWith(thrown)
  })

  it('不传 onError 时失败也不抛出（默认是空操作）', () => {
    const child = fakeChild()
    const spawnImpl = vi.fn().mockReturnValue(child)

    openBrowser(URL_WITH_TOKEN, { platform: 'linux', spawnImpl: spawnImpl as never })
    expect(() => child.emit('error', new Error('ENOENT'))).not.toThrow()
  })

  it('不传 platform 时落到 process.platform（仍不会真的 spawn）', () => {
    const child = fakeChild()
    const spawnImpl = vi.fn().mockReturnValue(child)

    openBrowser(URL_WITH_TOKEN, { spawnImpl: spawnImpl as never })

    const expected = resolveBrowserLaunchCommand(URL_WITH_TOKEN, process.platform)
    const [command, args] = spawnImpl.mock.calls[0] as [string, string[]]
    expect(command).toBe(expected.command)
    expect(args).toEqual(expected.args)
  })
})
