// 两态各自装上了哪一种「页面要没了，先把恢复写队列排空」的时机。
// ---------------------------------------------------------------------------
// 安装器换成替身：它自己的行为（pagehide 监听与解绑）有
// `persistence/recoveryFlushLifecycle.test.ts` 管，本文件只回答「装配层挑了哪一条、传了什么」。
//
// 【T1 删掉了什么】桌面端曾有第二条通路（可 await 的关窗拦截：preventDefault → flush → destroy），
// 于是本文件此前的两条主力用例钉的是「早退 return 在不在」与「桌面那条真的被 await 了」——
// 两者都是那条分支专属的。桌面端退出后函数只剩一支，那两条用例失去被测对象，随之删掉。
//
// 留下来的判据是**递进来的 Core 原样交出去**：两条通路都只碰它，绝不触默认 facade 的持久化桥。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CoreInstance } from '@einfach-agent/core'
import type { ResolvedHost } from './resolveHost'

const mocks = vi.hoisted(() => ({
  installBrowserRecoveryFlush: vi.fn(),
}))

vi.mock('../persistence/recoveryFlushLifecycle', () => ({
  installBrowserRecoveryFlush: mocks.installBrowserRecoveryFlush,
}))

const { installHostRecoveryFlush } = await import('./hostRecoveryFlush')

const serverHost: ResolvedHost = { kind: 'server', platform: 'linux' }
const staticHost: ResolvedHost = { kind: 'static', reason: 'timeout' }

/** 安装器是替身，所以这里只需要一个可比身份的对象；生产路径传的是宿主装配出的 Core。 */
const core = { tag: 'assembled-core' } as unknown as CoreInstance

describe('installHostRecoveryFlush', () => {
  beforeEach(() => {
    // vitest 4 的 `restoreMocks: true` 只管 `vi.spyOn` 造的 spy，**不碰 `vi.fn()`**。
    vi.clearAllMocks()
    mocks.installBrowserRecoveryFlush.mockReturnValue(() => {})
  })

  it('server 宿主装浏览器那条，Core 原样交出去', async () => {
    await installHostRecoveryFlush(serverHost, core)

    expect(mocks.installBrowserRecoveryFlush).toHaveBeenCalledWith(core)
  })

  it('static 宿主同样只有浏览器那条', async () => {
    await installHostRecoveryFlush(staticHost, core)

    expect(mocks.installBrowserRecoveryFlush).toHaveBeenCalledWith(core)
  })
})
