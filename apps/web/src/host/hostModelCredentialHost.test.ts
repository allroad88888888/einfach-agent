// 两态与构建模式共同决定哪一个模型凭据宿主。
// ---------------------------------------------------------------------------
// 两个工厂换成哨兵，一次真实凭据读写都不发：三条命令的行为有自己的 colocated 测试
// （`settings/serverModelCredentialHost.test.ts`），在这里再跑一遍只会把「选错了宿主」和
// 「命令本身坏了」混成一条红。
//
// server 必须在 DEV 之前：混合会话仍然应使用本机后端。static + DEV 保留本地 relay 的环境变量
// 流程，static 构建产物才启用浏览器 BYOK；两条与隔壁 `hostModelTransport.ts` 的分支一一对应。
//
// `import.meta.env.DEV` 在 vitest 下**默认为 true**，所以每条用例都显式声明自己要哪一种构建模式：
// 不 stub 的用例测的其实是 dev 形态，而且它会绿。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelCredentialHost } from '../settings/modelCredentialHost'
import type { ResolvedHost } from './resolveHost'

const mocks = vi.hoisted(() => {
  /** 哨兵：只用来比对身份，三条凭据命令被真的调用就抛。 */
  const sentinel = (name: string, available: boolean): ModelCredentialHost => {
    const reject = async (): Promise<never> => {
      throw new Error(`${name} 的命令被真的调用了——本测试只关心选中了哪一个宿主`)
    }
    return { available, status: reject, save: reject, delete: reject }
  }
  return {
    serverHostValue: sentinel('serverModelCredentialHost', true),
    browserHostValue: sentinel('browserModelCredentialHost', true),
    unavailableHostValue: sentinel('unavailableModelCredentialHost', false),
    createServerModelCredentialHost: vi.fn(),
    createBrowserModelCredentialHost: vi.fn(),
    createUnavailableModelCredentialHost: vi.fn(),
  }
})

vi.mock('../settings/modelCredentialHost', () => ({
  createUnavailableModelCredentialHost: mocks.createUnavailableModelCredentialHost,
}))
vi.mock('../settings/serverModelCredentialHost', () => ({
  createServerModelCredentialHost: mocks.createServerModelCredentialHost,
}))
vi.mock('../settings/browserModelCredentialHost', () => ({
  createBrowserModelCredentialHost: mocks.createBrowserModelCredentialHost,
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
    mocks.createServerModelCredentialHost.mockReturnValue(mocks.serverHostValue)
    mocks.createBrowserModelCredentialHost.mockReturnValue(mocks.browserHostValue)
    mocks.createUnavailableModelCredentialHost.mockReturnValue(mocks.unavailableHostValue)
  })

  it('server 宿主走 HTTP 凭据通路，而不是与 static 同待遇', () => {
    setDev(false)
    const host = createHostModelCredentialHost(serverHost)

    expect(host).toBe(mocks.serverHostValue)
    // `available` 同时也是启动凭据门禁开不开的判据：落成 unavailable 的话，
    // 设置面板会把输入框整块收起来，用户在浏览器里再也存不进 Key。
    expect(host.available).toBe(true)
    expect(mocks.createUnavailableModelCredentialHost).not.toHaveBeenCalled()
  })

  it('server 宿主 + DEV 同时为真时仍走 server', () => {
    setDev(true)
    expect(createHostModelCredentialHost(serverHost)).toBe(mocks.serverHostValue)
    expect(mocks.createUnavailableModelCredentialHost).not.toHaveBeenCalled()
  })

  it('static 宿主在 pnpm dev 下保持 unavailable，与环境变量中继配对', () => {
    setDev(true)
    const host = createHostModelCredentialHost(staticHost)

    expect(host).toBe(mocks.unavailableHostValue)
    expect(host.available).toBe(false)
    expect(mocks.createServerModelCredentialHost).not.toHaveBeenCalled()
  })

  it('static 构建产物使用浏览器 localStorage BYOK 宿主', () => {
    setDev(false)
    expect(createHostModelCredentialHost(staticHost)).toBe(mocks.browserHostValue)
    expect(mocks.createServerModelCredentialHost).not.toHaveBeenCalled()
  })
})
