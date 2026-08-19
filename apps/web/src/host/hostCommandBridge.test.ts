// 三态各自往 core 的桥上登记了什么 —— **loader 与 platform 是同一次登记的两半**（S5）。
// ---------------------------------------------------------------------------
// 这个文件只回答一个问题：`registerHostCommandBridge` 把什么登记进了 `configureHostInvoke`。
// 所以 `invoke` / `httpInvoke` 两个本体都换成哨兵（真被当命令通道调用就抛），传输本身各有各的
// colocated 测试；在这里再跑一遍只会把「登记错了」和「传输本身坏了」混成一条红。
//
// **`configureHostInvoke` 用的是真货**，不是替身：本卡要断言的不是「谁被调用了」，而是「core 那
// 一侧此刻究竟有没有桥、桥背后是谁、平台是什么」——那三个问题只有真的 hostBridge 模块答得了，
// 而它正是 `hasHostBridge()` / `loadHostInvoke()` / `hostPlatform()` 三个读出口的持有者。
// 代价是桥与平台都是**模块级单例**：每条用例前后都要推回 `configureHostInvoke(undefined)`，
// 否则同一个 worker 里后续的用例会莫名其妙地拥有本机能力。
//
// ★ `detectLocalPlatform` 为什么必须替身 ★
// 它返回的是**跑测试这台机器**的平台，于是「tauri 用本地探测」这条断言在 CI 的某个平台上会与
// 「有人把 tauri 那支写死成某个字面量」这种错误撞成同一个绿。换成替身之后，钉住它的是
// `toHaveBeenCalledOnce()`——写死字面量的话那次调用就不见了。反过来 server 那支钉的是
// `not.toHaveBeenCalled()`：**两态的平台来源不能互抄**，浏览器（macOS）连 Node 服务端（Linux）时
// 本地探测出来的值是错的，而错的后果是每条 shell 命令都撞 platform mismatch。

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostInvoke } from '@einfach-agent/core'
import type { ResolvedHost } from './resolveHost'

const mocks = vi.hoisted(() => {
  /** 哨兵：被真的当命令通道调用就抛——本文件只比对身份。 */
  const sentinel = (name: string): HostInvoke => {
    const impl = async <T>(): Promise<T> => {
      throw new Error(`${name} 被真的当作宿主 invoke 调用了——本测试只关心登记了哪一个`)
    }
    Object.defineProperty(impl, 'name', { value: name })
    return impl
  }
  return {
    tauriInvoke: sentinel('tauriInvoke'),
    httpInvoke: sentinel('httpInvoke'),
    detectLocalPlatform: vi.fn(),
    getServerInvokeToken: vi.fn(),
  }
})

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.tauriInvoke }))
vi.mock('./serverInvoke', () => ({ httpInvoke: mocks.httpInvoke }))
vi.mock('./serverInvokeToken', () => ({ getServerInvokeToken: mocks.getServerInvokeToken }))
// 只换掉本地平台探测，`configureHostInvoke` 保持真货（见文件头）。
vi.mock('@einfach-agent/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@einfach-agent/core')>()),
  detectLocalPlatform: mocks.detectLocalPlatform,
}))

const { registerHostCommandBridge } = await import('./hostCommandBridge')
const { configureHostInvoke, hasHostBridge, loadHostInvoke } = await import(
  '@einfach-agent/core/runtime/hostBridge'
)
const { hostPlatform } = await import('@einfach-agent/core/runtime/hostPlatform')

/** 本地探测的返回值。取一个固定字面量，让断言与跑测试的机器无关。 */
const LOCAL_PLATFORM = 'windows'

const tauriHost: ResolvedHost = { kind: 'tauri' }
const serverHost: ResolvedHost = { kind: 'server', platform: 'linux' }
const staticHost: ResolvedHost = { kind: 'static', reason: 'unreachable' }

describe('registerHostCommandBridge', () => {
  beforeEach(() => {
    // vitest 4 的 `restoreMocks: true` 只管 `vi.spyOn` 造的 spy，**不碰 `vi.fn()`**——
    // 「本地探测一次都没被调用」这类断言会读到上一条用例留下的账，串出来的账恰好让断言变严。
    vi.clearAllMocks()
    mocks.detectLocalPlatform.mockReturnValue(LOCAL_PLATFORM)
    // 桥与平台是模块级单例，每条用例都从「没有桥」出发。
    configureHostInvoke(undefined)
  })

  afterAll(() => {
    // 留着桥的话，同一个 worker 里后面的用例会意外拥有本机能力。
    configureHostInvoke(undefined)
  })

  it('tauri 宿主登记原生 invoke，平台取自本地探测', async () => {
    registerHostCommandBridge(tauriHost)

    expect(hasHostBridge()).toBe(true)
    await expect(loadHostInvoke()).resolves.toBe(mocks.tauriInvoke)
    expect(hostPlatform()).toBe(LOCAL_PLATFORM)
    // 写死字面量的话这次调用就不见了。
    expect(mocks.detectLocalPlatform).toHaveBeenCalledOnce()
    // 桌面端一次网络都不该发，token 那半是 server 专属的副作用。
    expect(mocks.getServerInvokeToken).not.toHaveBeenCalled()
  })

  it('server 宿主登记 HTTP invoke，平台取自握手而不是本地探测', async () => {
    registerHostCommandBridge(serverHost)

    expect(hasHostBridge()).toBe(true)
    await expect(loadHostInvoke()).resolves.toBe(mocks.httpInvoke)
    // 本地探测此刻答的是 'windows'，core 的唯一读出口却必须答握手值。
    expect(hostPlatform()).toBe('linux')
    expect(mocks.detectLocalPlatform).not.toHaveBeenCalled()
  })

  it("握手报回 'unsupported' 时原样传下去，不映射成三选一（S5 判据④）", () => {
    // core 认识第四个值（FreeBSD / AIX 这类：文件能力照常、shell 没有对应项）。
    // 在装配层替它兜成 macos/linux/windows 等于谎报，后果是每条 shell 命令都撞 platform mismatch。
    registerHostCommandBridge({ kind: 'server', platform: 'unsupported' })

    expect(hostPlatform()).toBe('unsupported')
    expect(mocks.detectLocalPlatform).not.toHaveBeenCalled()
  })

  it('server 宿主在登记那一刻就把 token 收走，不等第一条请求（顺序判据）', async () => {
    // `getServerInvokeToken()` 顺带做的是「读走 query 里的 token → 存 sessionStorage →
    // 把 token 从地址栏抹掉」。若它只在 loader 里（或更晚的请求路径上）被调用，
    // 「用户打开页面但一条命令都还没跑」的整段时间里 token 都留在地址栏——
    // 进浏览器历史、进截图、页面外链还会进 Referer，而那正是抹它的全部理由。
    registerHostCommandBridge(serverHost)

    // 关键在这一行的位置：还没有人碰过 loader。
    expect(mocks.getServerInvokeToken).toHaveBeenCalledOnce()

    await loadHostInvoke()
    // 解析 loader 不会再收一次——收 token 是登记的一部分，不是请求路径的一部分。
    expect(mocks.getServerInvokeToken).toHaveBeenCalledOnce()
  })

  it('static 宿主什么都不登记：没有桥、不探测平台、也不碰 token', async () => {
    // 登记等于骗 core 说有本机能力，模型会看到一堆调用即失败的工具。
    registerHostCommandBridge(staticHost)

    expect(hasHostBridge()).toBe(false)
    await expect(loadHostInvoke()).rejects.toThrow(/No host invoke bridge is configured/)
    expect(mocks.detectLocalPlatform).not.toHaveBeenCalled()
    expect(mocks.getServerInvokeToken).not.toHaveBeenCalled()
  })
})
