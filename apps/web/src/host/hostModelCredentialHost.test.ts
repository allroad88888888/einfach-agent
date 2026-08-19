// 三态各自拿到哪一个模型凭据宿主 —— 以及**构建模式一次都不许插手**。
// ---------------------------------------------------------------------------
// 三个工厂全部换成哨兵，一次真实凭据读写都不发：三条命令的行为各有各的 colocated 测试
// （`settings/modelCredentialHost.test.ts` 与 `settings/serverModelCredentialHost.test.ts`），
// 在这里再跑一遍只会把「选错了宿主」和「命令本身坏了」混成一条红。
//
// ★ 本模块的顺序敏感点不在模块内部，在模块之间 ★
// `host.kind` 是可辨识联合，三支互斥，把 tauri 与 server 两个 `if` 调个个儿也不改变任何行为
// ——**这个文件里没有内部顺序可钉**。真正会咬人的顺序在隔壁：`hostModelTransport.ts` 里
// server 与 `import.meta.env.DEV` 是两个正交判据、必须 server 在前，而那条注释给出的理由是
// 「本模块是 `tauri → server → unavailable`，**没有 DEV 分支**」。也就是说，隔壁那条排序的正确性
// 依赖本模块的一条性质，而本模块此前一条测试都没有——谁哪天在这里插一句
// `if (import.meta.env.DEV) return createUnavailableModelCredentialHost()`，
// 一个「`pnpm dev` 前端 + 真 apps/server 后端」的混合会话就会变成：Key 存不进去（本模块答
// unavailable），请求却照发（传输答 server）。所以下面三条用例把「DEV 抢不走任何一态」逐态钉死，
// 那才是本文件对全局的贡献。
//
// `import.meta.env.DEV` 在 vitest 下**默认为 true**，所以每条用例都显式声明自己要哪一种构建模式：
// 不 stub 的用例测的其实是 dev 形态，而且它会绿。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelCredentialHost } from '../settings/modelCredentialHost'
import type { ResolvedHost } from './resolveHost'

const mocks = vi.hoisted(() => {
  /** 哨兵：只用来比对身份，三条命令被真的调用就抛。 */
  const sentinel = (name: string, available: boolean): ModelCredentialHost => {
    const reject = async (): Promise<never> => {
      throw new Error(`${name} 的命令被真的调用了——本测试只关心选中了哪一个宿主`)
    }
    return { available, status: reject, save: reject, delete: reject }
  }
  return {
    tauriHostValue: sentinel('tauriModelCredentialHost', true),
    serverHostValue: sentinel('serverModelCredentialHost', true),
    unavailableHostValue: sentinel('unavailableModelCredentialHost', false),
    createTauriModelCredentialHost: vi.fn(),
    createServerModelCredentialHost: vi.fn(),
    createUnavailableModelCredentialHost: vi.fn(),
  }
})

vi.mock('../settings/modelCredentialHost', () => ({
  createTauriModelCredentialHost: mocks.createTauriModelCredentialHost,
  createUnavailableModelCredentialHost: mocks.createUnavailableModelCredentialHost,
}))
vi.mock('../settings/serverModelCredentialHost', () => ({
  createServerModelCredentialHost: mocks.createServerModelCredentialHost,
}))

const { createHostModelCredentialHost } = await import('./hostModelCredentialHost')

const serverHost: ResolvedHost = { kind: 'server', platform: 'linux' }
const staticHost: ResolvedHost = { kind: 'static', reason: 'unhealthy' }

/** `import.meta.env.DEV` 在 vitest 下默认为 true，所以每条用例都显式声明。 */
function setDev(value: boolean): void {
  vi.stubEnv('DEV', value)
}

describe('createHostModelCredentialHost', () => {
  beforeEach(() => {
    // vitest 4 的 `restoreMocks: true` 只管 `vi.spyOn` 造的 spy，**不碰 `vi.fn()`**——
    // 「某工厂一次都没被造出来」这类断言会跨用例串账。
    vi.clearAllMocks()
    mocks.createTauriModelCredentialHost.mockReturnValue(mocks.tauriHostValue)
    mocks.createServerModelCredentialHost.mockReturnValue(mocks.serverHostValue)
    mocks.createUnavailableModelCredentialHost.mockReturnValue(mocks.unavailableHostValue)
  })

  it('tauri 宿主走桌面原生层，且不受构建模式影响', () => {
    setDev(true)
    expect(createHostModelCredentialHost({ kind: 'tauri' })).toBe(mocks.tauriHostValue)
    expect(mocks.createServerModelCredentialHost).not.toHaveBeenCalled()
    expect(mocks.createUnavailableModelCredentialHost).not.toHaveBeenCalled()
  })

  it('server 宿主走 M4 的 HTTP 凭据通路，而不是与 static 同待遇', () => {
    setDev(false)
    const host = createHostModelCredentialHost(serverHost)

    expect(host).toBe(mocks.serverHostValue)
    // `available` 同时也是启动凭据门禁开不开的判据：落成 unavailable 的话，
    // 设置面板会把输入框整块收起来，用户在浏览器里再也存不进 Key。
    expect(host.available).toBe(true)
    expect(mocks.createTauriModelCredentialHost).not.toHaveBeenCalled()
    expect(mocks.createUnavailableModelCredentialHost).not.toHaveBeenCalled()
  })

  it('server 宿主 + DEV 同时为真时仍走 server —— 与模型传输由同一个判据选出', () => {
    setDev(true)
    expect(createHostModelCredentialHost(serverHost)).toBe(mocks.serverHostValue)
    // 隔壁 `hostModelTransport.ts` 那条「server 必须排在 DEV 之前」的排序，
    // 其正确性依赖的就是这一行：本模块**没有** DEV 分支。
    expect(mocks.createUnavailableModelCredentialHost).not.toHaveBeenCalled()
    expect(mocks.createTauriModelCredentialHost).not.toHaveBeenCalled()
  })

  it('static 宿主在 pnpm dev 下依然 unavailable —— DEV 不给它开凭据后门', () => {
    // 模型传输在这一格是有 dev 中继的（`createDevPreviewModelFetch`），凭据宿主**没有**对应物：
    // dev 中继只认 `DEEPSEEK_API_KEY` 这类环境变量，前端存不存 Key 与它无关。
    setDev(true)
    const host = createHostModelCredentialHost(staticHost)

    expect(host).toBe(mocks.unavailableHostValue)
    expect(host.available).toBe(false)
    expect(mocks.createServerModelCredentialHost).not.toHaveBeenCalled()
    expect(mocks.createTauriModelCredentialHost).not.toHaveBeenCalled()
  })

  it('static 宿主在构建产物里同样 unavailable：背后没有能写文件的机器', () => {
    setDev(false)
    expect(createHostModelCredentialHost(staticHost)).toBe(mocks.unavailableHostValue)
    expect(mocks.createServerModelCredentialHost).not.toHaveBeenCalled()
    expect(mocks.createTauriModelCredentialHost).not.toHaveBeenCalled()
  })
})
