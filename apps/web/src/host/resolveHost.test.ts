import { afterEach, describe, expect, it, vi } from 'vitest'
import { HEALTH_PROBE_TIMEOUT_MS, resolveHost, type ResolveHostOptions } from './resolveHost'

const healthyPayload = {
  service: 'einfach-agent',
  host: 'node-server',
  version: '0.1.0',
  platform: 'linux',
}

/** 满足 `HealthProbeResponse` 的最小应答；测试从不构造真的 `Response`，也从不发真请求。 */
const respondWith = (
  body: { ok?: boolean; status?: number; json: () => Promise<unknown> },
) => vi.fn(async () => ({ ok: body.ok ?? true, status: body.status ?? 200, json: body.json }))

const jsonResponse = (payload: unknown) => respondWith({ json: async () => payload })

/** 生产默认的 fetch 一律不参与：探测面由用例给，缺了就该在类型上被发现。 */
const browserHost = (fetch: ResolveHostOptions['fetch']): ResolveHostOptions => ({ fetch })

afterEach(() => {
  vi.useRealTimers()
})

describe('resolveHost', () => {
  it('握手成功时判 server，并把宿主声明的平台带出来', async () => {
    const fetch = jsonResponse(healthyPayload)
    await expect(resolveHost(browserHost(fetch))).resolves.toEqual({
      kind: 'server',
      platform: 'linux',
    })
    expect(fetch).toHaveBeenCalledTimes(1)
    const [path, init] = fetch.mock.calls[0] as unknown as [string, { signal: AbortSignal }]
    expect(path).toBe('/api/health')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it("平台是 'unsupported' 时原样带出", async () => {
    await expect(resolveHost(browserHost(jsonResponse({ ...healthyPayload, platform: 'unsupported' }))))
      .resolves.toEqual({ kind: 'server', platform: 'unsupported' })
  })

  it('忽略未知字段', async () => {
    await expect(resolveHost(browserHost(jsonResponse({ ...healthyPayload, futureField: 'x' }))))
      .resolves.toEqual({ kind: 'server', platform: 'linux' })
  })

  it('200 + JSON 但不是我们的服务时判 static —— 只判 200 不够', async () => {
    // 本机任何开发服务器都可能在同一端口对 /api/health 回 200；误判的后果是整个应用
    // 去打一个不存在的命令桥。
    await expect(resolveHost(browserHost(jsonResponse({ status: 'ok' }))))
      .resolves.toEqual({ kind: 'static', reason: 'unrecognized' })
    await expect(resolveHost(browserHost(jsonResponse({ ...healthyPayload, host: 'other' }))))
      .resolves.toEqual({ kind: 'static', reason: 'unrecognized' })
  })

  it('身份对上但平台报不出来时判 static，不猜也不回落', async () => {
    const { platform: _dropped, ...withoutPlatform } = healthyPayload
    await expect(resolveHost(browserHost(jsonResponse(withoutPlatform))))
      .resolves.toEqual({ kind: 'static', reason: 'unrecognized' })
  })

  it('SPA 回落成一整页 HTML（json() 抛）时判 static，不变成未捕获错误', async () => {
    // 真·静态部署下 /api/health 大概率就是这个形态：200 + text/html + 一整页 index.html。
    const fetch = respondWith({
      json: async () => {
        throw new SyntaxError('Unexpected token \'<\', "<!doctype "... is not valid JSON')
      },
    })
    await expect(resolveHost(browserHost(fetch)))
      .resolves.toEqual({ kind: 'static', reason: 'unrecognized' })
  })

  it('非 2xx 时判 static', async () => {
    const fetch = respondWith({ ok: false, status: 404, json: async () => ({}) })
    await expect(resolveHost(browserHost(fetch)))
      .resolves.toEqual({ kind: 'static', reason: 'unhealthy' })
  })

  it('请求直接失败时判 static', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    await expect(resolveHost(browserHost(fetch)))
      .resolves.toEqual({ kind: 'static', reason: 'unreachable' })
  })

  it('挂着不回包时超时落 static，并真的把请求取消掉', async () => {
    let captured: AbortSignal | undefined
    const fetch = vi.fn((_path: string, init: { signal: AbortSignal }) => {
      captured = init.signal
      // 真 fetch 的行为：被 abort 时以 AbortError 拒绝。
      return new Promise<never>((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        })
      })
    })
    await expect(resolveHost({ ...browserHost(fetch), timeoutMs: 5 }))
      .resolves.toEqual({ kind: 'static', reason: 'timeout' })
    // 只 resolve 不 abort 的话首屏是不挂了，但那条请求还挂在连接池里、且已经没有消费方。
    expect(captured?.aborted).toBe(true)
  })

  it('fetch 实现完全不理会 abort 时，仍然在超时后落 static', async () => {
    // 「探测失败」包含「永远不返回」。只上 AbortController 的话，「超时后一定返回」就成了对
    // fetch 实现的假设——这条用例在没有 Promise.race 兜底时会**永远挂着**，而那正是本卡要
    // 排除的首屏白屏。
    const fetch = vi.fn(() => new Promise<never>(() => {}))
    await expect(resolveHost({ ...browserHost(fetch), timeoutMs: 5 }))
      .resolves.toEqual({ kind: 'static', reason: 'timeout' })
  })

  it('默认超时落在「不至于误判、也不至于白屏」的区间里', () => {
    // 刻意**不写死等于 2000**：这是一个调参值，把它钉死只会让下次调参多改一行测试，
    // 而真正不能越的是两头——太短会把一台冷启动中的真 server 判成 static（静默降级，
    // 模型看不到任何本机能力），太长就是让用户对着白屏干等。回环同源请求正常是毫秒级。
    expect(HEALTH_PROBE_TIMEOUT_MS).toBeGreaterThanOrEqual(1000)
    expect(HEALTH_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(5000)
  })

  it('不传 timeoutMs 时用那个默认值（而不是另一个数）', async () => {
    vi.useFakeTimers()
    const settled = vi.fn()
    const pending = resolveHost(browserHost(vi.fn(() => new Promise<never>(() => {}))))
    void pending.then(settled)

    await vi.advanceTimersByTimeAsync(HEALTH_PROBE_TIMEOUT_MS - 1)
    expect(settled).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).resolves.toEqual({ kind: 'static', reason: 'timeout' })
  })

  it('成功路径不留悬挂定时器', async () => {
    vi.useFakeTimers()
    await resolveHost(browserHost(jsonResponse(healthyPayload)))
    expect(vi.getTimerCount()).toBe(0)
  })
})
