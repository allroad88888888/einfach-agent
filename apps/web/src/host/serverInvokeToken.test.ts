import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getServerInvokeToken,
  type ServerInvokeTokenEnvironment,
} from './serverInvokeToken'

const STORAGE_KEY = 'web-agent:server-invoke-token'

/** 造一个完全假的环境——不碰真实 `window`，所以本文件的用例不受 jsdom 版本差异影响。 */
function fakeEnvironment(options: {
  href: string
  stored?: string
  historyState?: unknown
  setItemThrows?: boolean
  replaceStateThrows?: boolean
}): { env: ServerInvokeTokenEnvironment, replaceState: ReturnType<typeof vi.fn>, setItem: ReturnType<typeof vi.fn> } {
  const store = new Map<string, string>()
  if (options.stored !== undefined) store.set(STORAGE_KEY, options.stored)

  const setItem = vi.fn((key: string, value: string) => {
    if (options.setItemThrows) throw new Error('storage unavailable')
    store.set(key, value)
  })
  const replaceState = vi.fn((_state: unknown, _unused: string, _url?: string | URL | null) => {
    if (options.replaceStateThrows) throw new Error('replaceState unavailable')
  })

  const env: ServerInvokeTokenEnvironment = {
    location: { href: options.href },
    history: {
      state: options.historyState ?? null,
      replaceState,
    },
    sessionStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem,
    },
  }
  return { env, replaceState, setItem }
}

describe('getServerInvokeToken', () => {
  it('query 与 sessionStorage 都没有时返回 undefined', () => {
    const { env } = fakeEnvironment({ href: 'http://127.0.0.1:4765/' })
    expect(getServerInvokeToken(env)).toBeUndefined()
  })

  it('query 有 token 时：返回它、写进 sessionStorage、并清掉地址栏里的 token', () => {
    const { env, replaceState, setItem } = fakeEnvironment({
      href: 'http://127.0.0.1:4765/some/path?token=fresh-token&foo=bar#section',
      historyState: { existing: 1 },
    })
    expect(getServerInvokeToken(env)).toBe('fresh-token')
    expect(setItem).toHaveBeenCalledWith(STORAGE_KEY, 'fresh-token')
    // 保留 path、其余 query 参数与 hash；只抹掉 token 这一个键；history.state 原样传下去。
    expect(replaceState).toHaveBeenCalledWith({ existing: 1 }, '', '/some/path?foo=bar#section')
  })

  it('query 没有 token、sessionStorage 有：退到 sessionStorage 里的值，不触碰地址栏', () => {
    const { env, replaceState, setItem } = fakeEnvironment({
      href: 'http://127.0.0.1:4765/',
      stored: 'stored-token',
    })
    expect(getServerInvokeToken(env)).toBe('stored-token')
    expect(setItem).not.toHaveBeenCalled()
    expect(replaceState).not.toHaveBeenCalled()
  })

  it('query 与 sessionStorage 都有且不同：query 赢（新链接覆盖旧缓存）', () => {
    const { env, setItem } = fakeEnvironment({
      href: 'http://127.0.0.1:4765/?token=new-token',
      stored: 'old-token',
    })
    expect(getServerInvokeToken(env)).toBe('new-token')
    expect(setItem).toHaveBeenCalledWith(STORAGE_KEY, 'new-token')
  })

  it('空 token（`?token=`）当作没有，退到 sessionStorage', () => {
    const { env, setItem } = fakeEnvironment({
      href: 'http://127.0.0.1:4765/?token=',
      stored: 'stored-token',
    })
    expect(getServerInvokeToken(env)).toBe('stored-token')
    expect(setItem).not.toHaveBeenCalled()
  })

  it('sessionStorage 写入失败：不清地址栏（否则 token 哪儿都不在），但这一次调用仍然可用', () => {
    const { env, replaceState } = fakeEnvironment({
      href: 'http://127.0.0.1:4765/?token=fresh-token',
      setItemThrows: true,
    })
    expect(getServerInvokeToken(env)).toBe('fresh-token')
    expect(replaceState).not.toHaveBeenCalled()
  })

  it('history.replaceState 失败：不影响返回值，静默吞掉（token 已经进了 storage）', () => {
    const { env } = fakeEnvironment({
      href: 'http://127.0.0.1:4765/?token=fresh-token',
      replaceStateThrows: true,
    })
    expect(() => getServerInvokeToken(env)).not.toThrow()
    expect(getServerInvokeToken(env)).toBe('fresh-token')
  })

  it('sessionStorage.getItem 抛出时按"没有"处理，不让整条链路炸掉', () => {
    const env: ServerInvokeTokenEnvironment = {
      location: { href: 'http://127.0.0.1:4765/' },
      history: { state: null, replaceState: vi.fn() },
      sessionStorage: {
        getItem: () => {
          throw new Error('blocked')
        },
        setItem: vi.fn(),
      },
    }
    expect(getServerInvokeToken(env)).toBeUndefined()
  })

  it("`location.href` 解析失败时按'没有 query token'处理", () => {
    const env: ServerInvokeTokenEnvironment = {
      location: { href: 'not a url' },
      history: { state: null, replaceState: vi.fn() },
      sessionStorage: {
        getItem: () => 'fallback-token',
        setItem: vi.fn(),
      },
    }
    expect(getServerInvokeToken(env)).toBe('fallback-token')
  })
})

describe('getServerInvokeToken() 不传参数（生产默认值）', () => {
  beforeEach(() => {
    window.sessionStorage.clear()
    window.history.replaceState(null, '', '/')
  })

  it('用真实 window 时不抛出，且干净状态下返回 undefined', () => {
    expect(() => getServerInvokeToken()).not.toThrow()
    expect(getServerInvokeToken()).toBeUndefined()
  })

  it('真实 window：query 里的 token 会被消费并清出地址栏', () => {
    window.history.replaceState(null, '', '/?token=real-window-token')
    expect(getServerInvokeToken()).toBe('real-window-token')
    expect(window.location.search).toBe('')
    expect(window.sessionStorage.getItem(STORAGE_KEY)).toBe('real-window-token')
  })
})
