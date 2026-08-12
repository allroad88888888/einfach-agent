// 占位同步器的第一组判据：那条 desired 规则，以及它在四个时机各自被重算。
// 写 registry 的纪律（跳过 / expected 注销 / 撞名留痕）在 placeholderSync.registry.test.ts。
//
//   desired(serverId) = 该服务在 manager 登记表里 且 status !== 'connected'
//                       ? 缓存里该服务的工具名集合
//                       : ∅

import { describe, expect, it } from 'vitest'
import {
  lastKnown,
  setupPlaceholderSync,
  snapshot,
  stdioSnapshot,
} from './placeholderSync.fixtures'

describe('desired 规则', () => {
  it('已登记但未连接的服务：缓存清单原样成为占位集合', () => {
    const wired = setupPlaceholderSync()

    expect(wired.names()).toEqual(['mcp__docs__draft', 'mcp__docs__search'])
    expect(wired.claims.namesFor('docs').sort())
      .toEqual(['mcp__docs__draft', 'mcp__docs__search'])
    // runtime 跟着配置走：HTTP → internal。
    expect(wired.runtime('mcp__docs__search')).toBe('internal')
  })

  it('stdio 服务的占位标成 server runtime——浏览器下会被 isToolVisible 过滤掉', () => {
    const wired = setupPlaceholderSync({
      servers: [stdioSnapshot('local', 'disconnected')],
      cache: { local: lastKnown('local', ['mcp__local__run']) },
    })

    expect(wired.runtime('mcp__local__run')).toBe('server')
  })

  it('缓存里没有清单的服务没有占位：从未探测、探测失败、探测到空清单三种都算', () => {
    const never = setupPlaceholderSync({ cache: {} })
    expect(never.names()).toEqual([])

    const failed = setupPlaceholderSync({
      cache: { docs: lastKnown('docs', ['mcp__docs__search'], { probeStatus: 'failed' }) },
    })
    expect(failed.names()).toEqual([])

    const empty = setupPlaceholderSync({ cache: { docs: lastKnown('docs', []) } })
    expect(empty.names()).toEqual([])
  })
})

describe('四个重算时机', () => {
  it('时机一 · manager 状态变化：连上就清空占位，断开就回来', () => {
    const wired = setupPlaceholderSync()
    expect(wired.names()).toHaveLength(2)

    wired.setStatus('docs', 'connected')

    // 服务一旦 connected，它的占位集合恒为空——真实工具已经在 registry 里了。
    expect(wired.names()).toEqual([])
    expect(wired.claims.namesFor('docs')).toEqual([])

    // 「现在没连着」绝不是「这个服务没有工具」：断开、失败、退避重连期间占位都回来。
    wired.setStatus('docs', 'reconnecting')
    expect(wired.names()).toHaveLength(2)
    wired.setStatus('docs', 'error')
    expect(wired.names()).toHaveLength(2)
  })

  it('时机二 · 缓存写入/删除之后：宿主调一次 sync()，增删立刻反映到占位集合', () => {
    const wired = setupPlaceholderSync({ cache: {} })
    expect(wired.names()).toEqual([])

    // 一次探测写进缓存。
    wired.setCache({ docs: lastKnown('docs', ['mcp__docs__search']) })
    wired.sync.sync()
    expect(wired.names()).toEqual(['mcp__docs__search'])

    // 再探测一次：远端少了一个工具、换了另一个。
    wired.setCache({ docs: lastKnown('docs', ['mcp__docs__draft']) })
    wired.sync.sync()
    expect(wired.names()).toEqual(['mcp__docs__draft'])

    // 缓存条目被整条删掉（服务删除时的级联清理）。
    wired.setCache({})
    wired.sync.sync()
    expect(wired.names()).toEqual([])
    expect(wired.claims.namesFor('docs')).toEqual([])
  })

  it('时机三 · hydrate 完成：登记表与缓存都就位后一次 sync() 把占位全部装上', () => {
    // 冷启动的真实顺序：装配那一刻缓存还没读盘 → 一个占位都算不出来。
    const wired = setupPlaceholderSync({ cache: {} })
    expect(wired.names()).toEqual([])

    // hydrate 期间服务被登记进 manager（这一步自己会 emit，但缓存还是空的）。
    wired.add(snapshot('github', 'disconnected'))
    expect(wired.names()).toEqual([])

    // 读盘完成，宿主补一次重算。
    wired.setCache({
      docs: lastKnown('docs', ['mcp__docs__search']),
      github: lastKnown('github', ['mcp__github__create_issue']),
    })
    wired.sync.sync()

    expect(wired.names()).toEqual(['mcp__docs__search', 'mcp__github__create_issue'])
  })

  it('时机四 · 服务被删除：登记表里没有了 → desired = ∅，占位随之注销', () => {
    const wired = setupPlaceholderSync()
    expect(wired.names()).toHaveLength(2)

    // 缓存条目此刻可能还没来得及被级联清掉——判据是登记表，不是缓存。
    wired.remove('docs')

    expect(wired.names()).toEqual([])
    expect(wired.claims.namesFor('docs')).toEqual([])
  })

  it('宿主探针抛错：这一轮不动这个服务的占位，不把「问不到」当成「没有工具」', () => {
    const wired = setupPlaceholderSync()
    expect(wired.names()).toHaveLength(2)

    wired.probe.mockImplementation(() => {
      throw new Error('config file is gone')
    })
    wired.sync.sync()

    expect(wired.names()).toHaveLength(2)
  })

  it('dispose 之后 manager 的状态变化不再驱动占位', () => {
    const wired = setupPlaceholderSync()
    expect(wired.names()).toHaveLength(2)

    wired.sync.dispose()
    wired.setStatus('docs', 'connected')

    // 已注册的占位不在 dispose 里清除，但也不再跟着 manager 走。
    expect(wired.names()).toHaveLength(2)
  })
})
