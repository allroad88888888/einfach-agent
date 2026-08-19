// 三态各自装上了哪一种「页面/窗口要没了，先把恢复写队列排空」的时机。
// ---------------------------------------------------------------------------
// 两个安装器都换成替身：它们各自的行为（preventDefault → flush → destroy、pagehide 监听与解绑）
// 有 `persistence/recoveryFlushLifecycle.test.ts` 管，本文件只回答「装配层挑了哪一条、传了什么」。
//
// ★ 顺序敏感点：tauri 那支的 `return` ★
// 这个函数是「早退 + 兜底」形态（`if (tauri) { …; return }` 后面直接跟浏览器那条），
// 所以它的顺序不体现在两个条件谁先判，而体现在那一句 `return` 在不在。漏了它，桌面端会**两条都装**：
// 关窗拦截照常生效，同时 window 上多一个 pagehide 监听——两个 flush 并发跑同一个写队列，
// 而这在功能上看不出任何异常（flush 幂等、页面照样关掉）。只有「另一条一次都没被调用」这种断言
// 抓得住它，所以下面每条用例都带着它的反面。
//
// ★ 为什么要单独钉「真的 await 了」★
// 桌面那条返回的是 Promise，`installHostRecoveryFlush` 自己也是 async。把 `await` 写丢的话，
// 装配层会在拦截器**还没挂上**的时候就继续往下走——那个窗口里用户按下关闭按钮，关窗不会被拦，
// 恢复队列直接丢。返回值形状不变，类型也不报错。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CoreInstance } from '@einfach-agent/core'
import type { ResolvedHost } from './resolveHost'

const mocks = vi.hoisted(() => ({
  desktopWindow: { tag: 'current-tauri-window' },
  getCurrentWindow: vi.fn(),
  installBrowserRecoveryFlush: vi.fn(),
  installDesktopRecoveryFlush: vi.fn(),
}))

vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: mocks.getCurrentWindow }))
vi.mock('../persistence/recoveryFlushLifecycle', () => ({
  installBrowserRecoveryFlush: mocks.installBrowserRecoveryFlush,
  installDesktopRecoveryFlush: mocks.installDesktopRecoveryFlush,
}))

const { installHostRecoveryFlush } = await import('./hostRecoveryFlush')

const serverHost: ResolvedHost = { kind: 'server', platform: 'linux' }
const staticHost: ResolvedHost = { kind: 'static', reason: 'timeout' }

/** 两个安装器都是替身，所以这里只需要一个可比身份的对象；生产路径传的是宿主装配出的 Core。 */
const core = { tag: 'assembled-core' } as unknown as CoreInstance

describe('installHostRecoveryFlush', () => {
  beforeEach(() => {
    // vitest 4 的 `restoreMocks: true` 只管 `vi.spyOn` 造的 spy，**不碰 `vi.fn()`**——
    // 下面每条用例都靠「另一条一次都没被调用」立论，不清就会读到上一条用例留下的账。
    vi.clearAllMocks()
    mocks.getCurrentWindow.mockReturnValue(mocks.desktopWindow)
    mocks.installDesktopRecoveryFlush.mockResolvedValue(() => {})
    mocks.installBrowserRecoveryFlush.mockReturnValue(() => {})
  })

  it('tauri 宿主装可 await 的关窗拦截，拿的是当前窗口，且不再挂 pagehide', async () => {
    await installHostRecoveryFlush({ kind: 'tauri' }, core)

    expect(mocks.getCurrentWindow).toHaveBeenCalledOnce()
    // 传进来的这个 Core 原样交出去——两条通路都只碰它，绝不触默认 facade 的持久化桥。
    expect(mocks.installDesktopRecoveryFlush).toHaveBeenCalledWith(core, mocks.desktopWindow)
    expect(mocks.installBrowserRecoveryFlush).not.toHaveBeenCalled()
  })

  it('桌面那条真的被 await 掉了：装完之前不返回', async () => {
    let finishInstall: (() => void) | undefined
    mocks.installDesktopRecoveryFlush.mockReturnValue(
      new Promise<() => void>((resolve) => { finishInstall = () => resolve(() => {}) }),
    )

    let settled = false
    const done = installHostRecoveryFlush({ kind: 'tauri' }, core).then(() => { settled = true })

    await vi.waitFor(() => { expect(mocks.installDesktopRecoveryFlush).toHaveBeenCalledOnce() })
    // 拦截器还挂在半空中，装配层就绝不该往下走。
    expect(settled).toBe(false)

    finishInstall?.()
    await done
    expect(settled).toBe(true)
  })

  it('server 宿主只有浏览器那条，完全不碰 Tauri 的 window API', async () => {
    await installHostRecoveryFlush(serverHost, core)

    expect(mocks.installBrowserRecoveryFlush).toHaveBeenCalledWith(core)
    expect(mocks.installDesktopRecoveryFlush).not.toHaveBeenCalled()
    // pagehide 不给任何等待机会，那是宿主能力的差别，不是实现细节的差别。
    expect(mocks.getCurrentWindow).not.toHaveBeenCalled()
  })

  it('static 宿主同样只有浏览器那条', async () => {
    await installHostRecoveryFlush(staticHost, core)

    expect(mocks.installBrowserRecoveryFlush).toHaveBeenCalledWith(core)
    expect(mocks.installDesktopRecoveryFlush).not.toHaveBeenCalled()
    expect(mocks.getCurrentWindow).not.toHaveBeenCalled()
  })
})
