// 装配点按宿主态定 capabilities（C3/C4）。存储通道那一半在 `initialize.storage.test.ts`，
// 共用夹具在 `initialize.testHarness.ts`。

import { describe, expect, it, vi } from 'vitest'
import type { ResolvedHost } from '../host/resolveHost'
import { freshHost, SERVER_HOST, STATIC_HOST } from './initialize.testHarness'

vi.mock('../host/serverInvoke', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../host/serverInvoke')>()
  return { ...actual, invokeServerCommand: vi.fn() }
})

/**
 * 两个 capability flag 回答的是**两个不同问题**（能不能在本机起子进程 / 凭据能不能落盘），
 * 只是恰好在 server 那一态上同时为真。`initialize.ts` 的接线注释这么写了，
 * 但在此之前没有测试守着——把任一个改成常量 false，就会静默地少一样能力：
 * stdio 少了会让 server 宿主的 stdio 服务连不上（`serverConnector.ts` 的准入判据），
 * credentials 少了会让凭据字段在设置面板里被判非法（`state.ts` 的 draft 校验）。
 */
describe('装配点按宿主态定 capabilities', () => {
  async function capabilitiesFor(host: ResolvedHost) {
    await freshHost()
    const { initializeMcpSettings: initializeFresh } = await import('./initialize')
    const { mcpSettingsCapabilitiesAtom } = await import('./state')
    const { uiStore } = await import('../uiStore')
    initializeFresh(host)
    return uiStore.getter(mcpSettingsCapabilitiesAtom)
  }

  it('server 宿主：stdio 与 credentials 都为真（本机 Node 后端替它 spawn、并读写同一份配置文件）', async () => {
    expect(await capabilitiesFor(SERVER_HOST)).toEqual({ stdio: true, credentials: true })
  })

  it('static 宿主：两者皆假', async () => {
    expect(await capabilitiesFor(STATIC_HOST)).toEqual({ stdio: false, credentials: false })
  })
})
