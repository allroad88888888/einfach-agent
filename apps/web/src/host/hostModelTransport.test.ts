// 两态各自选中哪一条模型传输，以及**分支的先后顺序**。
// ---------------------------------------------------------------------------
// 这个文件只回答一个问题：`createHostModelFetch` 挑了哪个传输。所以两条受管传输 mock 成哨兵，
// 一次真实请求都不发——传输本身各有各的 colocated 测试，在这里再跑一遍只会把「选错了分支」
// 和「传输本身坏了」两种失败混成一条红。
//
// ★ 为什么非要有第 3 条用例（server + DEV 同时为真）★
// `createHostModelFetch` 里 server 与 DEV 是**两个正交判据**：宿主是解析出来的（`/api/health`
// 应不应），DEV 是构建模式（`pnpm dev` 还是 `pnpm build`）。正常两种形态各占一边——`pnpm dev`
// 下 `/api/health` 404 → static + 有中继；`pnpm serve` 下 → server + 没中继——所以**只测这两种
// 正常形态，两个分支谁在前谁在后都是绿的**，顺序完全不设防。
// 真正把顺序钉住的是那个混合形态：`pnpm dev` 的前端 + 真 apps/server 后端。此时若 DEV 赢，
// 凭据宿主（`hostModelCredentialHost.ts` 是 `server → unavailable`，**没有 DEV 分支**）
// 会把 Key 经 `/api/invoke/model_credential_set` 存进后端配置文件，而请求发给只认
// `DEEPSEEK_API_KEY` 等环境变量的 Vite 中继——存进去了但发不出去，两边都不报错。
// 「凭据宿主与传输必须由同一个判据选出来」这句话，只有这条用例在兑现。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedHost } from './resolveHost'

/** 哨兵：被真的当 fetch 调用就抛——本文件只比对身份，不该有人去用它。 */
function sentinel(name: string): typeof fetch {
  const impl = (): never => {
    throw new Error(`${name} 被当作真实 fetch 调用了——本测试只关心选中了哪个工厂`)
  }
  Object.defineProperty(impl, 'name', { value: name })
  return impl as unknown as typeof fetch
}

const FETCHES = {
  server: sentinel('serverModelFetch'),
  dev: sentinel('devPreviewModelFetch'),
}

const mocks = vi.hoisted(() => ({
  createServerModelFetch: vi.fn(),
  createDevPreviewModelFetch: vi.fn(),
}))

vi.mock('../modelTransport/serverModelTransport', () => ({
  createServerModelFetch: mocks.createServerModelFetch,
}))
vi.mock('../modelTransport/devPreviewModelTransport', () => ({
  createDevPreviewModelFetch: mocks.createDevPreviewModelFetch,
}))
const { createHostModelFetch } = await import('./hostModelTransport')

const serverHost: ResolvedHost = { kind: 'server', platform: 'linux' }
const staticHost: ResolvedHost = { kind: 'static', reason: 'unreachable' }

/** `import.meta.env.DEV` 在 vitest 下默认为 true，所以每条用例都显式声明自己要哪一种构建模式。 */
function setDev(value: boolean): void {
  vi.stubEnv('DEV', value)
}

describe('createHostModelFetch', () => {
  beforeEach(() => {
    // vitest 4 的 `restoreMocks: true` 只管 `vi.spyOn` 造的 spy，**不碰 `vi.fn()`**——调用记录会
    // 跨用例累积，于是「dev 中继一次都没被造出来」这类断言会读到上一条用例留下的账。
    // 实测：漏掉这一行时，最后一条用例报「expected vi.fn() to not be called, but been called 1 times」。
    vi.clearAllMocks()
    mocks.createServerModelFetch.mockReturnValue(FETCHES.server)
    mocks.createDevPreviewModelFetch.mockReturnValue(FETCHES.dev)
  })

  it('server 宿主（pnpm serve / npx 的构建产物）走 HTTP 模型端点', () => {
    setDev(false)
    expect(createHostModelFetch(serverHost)).toBe(FETCHES.server)
  })

  it('server 宿主 + DEV 同时为真时仍走 server，不落到 dev 中继（顺序判据）', () => {
    setDev(true)
    expect(createHostModelFetch(serverHost)).toBe(FETCHES.server)
    // 不只是「返回值对」：dev 中继连造都没造出来，与凭据宿主由同一个判据选出。
    expect(mocks.createDevPreviewModelFetch).not.toHaveBeenCalled()
  })

  it('static 宿主在 pnpm dev 下走本地中继', () => {
    setDev(true)
    expect(createHostModelFetch(staticHost)).toBe(FETCHES.dev)
  })

  it('static 构建产物以浏览器原生 fetch 直连用户选择的 provider', () => {
    setDev(false)
    expect(createHostModelFetch(staticHost)).toBe(globalThis.fetch)
    expect(mocks.createDevPreviewModelFetch).not.toHaveBeenCalled()
  })
})
