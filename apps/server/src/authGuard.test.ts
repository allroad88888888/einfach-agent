import { describe, expect, it } from 'vitest'
import { authorizeApiRequest, type ApiRequestFacts } from './authGuard'
import { HEALTH_PATH } from './health'

const TOKEN = 'test-token-0123456789'
const CONFIG = { token: TOKEN }
const PORT = 3210

/** 一条「本机浏览器里我们自己的页面发出的、带对 token 的」请求。逐条用例只改它的一处。 */
function facts(overrides: Partial<ApiRequestFacts> = {}): ApiRequestFacts {
  return {
    pathname: '/api/invoke/run_shell_command',
    remoteAddress: '127.0.0.1',
    localPort: PORT,
    host: `127.0.0.1:${PORT}`,
    origin: `http://127.0.0.1:${PORT}`,
    authorization: `Bearer ${TOKEN}`,
    ...overrides,
  }
}

function deny(overrides: Partial<ApiRequestFacts>): { status: number, error: string } {
  const decision = authorizeApiRequest(facts(overrides), CONFIG)
  if (decision.kind !== 'deny') throw new Error(`预期拒绝，实际放行：${JSON.stringify(overrides)}`)
  return { status: decision.status, error: decision.error }
}

describe('正常调用方', () => {
  it('回环 + 自己的 Origin/Host + 正确 token → 放行', () => {
    expect(authorizeApiRequest(facts(), CONFIG)).toEqual({ kind: 'allow' })
  })

  it('curl 那一路：无 Origin、Host 正确、token 正确 → 放行', () => {
    expect(authorizeApiRequest(facts({ origin: undefined }), CONFIG)).toEqual({ kind: 'allow' })
  })
})

describe('第二道：token', () => {
  // 这是本卡最要紧的一条。没有它，本机任何网页里的 JS 都能 POST 一条 run_shell_command。
  it('无 token → 401 missing_token，并带标准质询头', () => {
    const decision = authorizeApiRequest(facts({ authorization: undefined }), CONFIG)
    expect(decision).toMatchObject({ kind: 'deny', status: 401, error: 'missing_token' })
    if (decision.kind !== 'deny') throw new Error('unreachable')
    expect(decision.headers).toEqual({ 'www-authenticate': 'Bearer' })
  })

  it('token 错、少一位、多一位、换 scheme → 全部 401', () => {
    expect(deny({ authorization: 'Bearer wrong' })).toEqual({ status: 401, error: 'invalid_token' })
    expect(deny({ authorization: `Bearer ${TOKEN.slice(0, -1)}` })).toEqual({ status: 401, error: 'invalid_token' })
    expect(deny({ authorization: `Bearer ${TOKEN}x` })).toEqual({ status: 401, error: 'invalid_token' })
    // scheme 不对 = 没带 token，而不是带错了。
    expect(deny({ authorization: `Basic ${TOKEN}` })).toEqual({ status: 401, error: 'missing_token' })
    expect(deny({ authorization: TOKEN })).toEqual({ status: 401, error: 'missing_token' })
  })

  it('token 只认请求头，不认 query——query 会进日志，且会让简单跨站请求重新活过来', () => {
    expect(deny({ pathname: '/api/invoke/run_shell_command', authorization: undefined }))
      .toEqual({ status: 401, error: 'missing_token' })
  })
})

describe('第一道：对端地址', () => {
  it('非回环对端 → 403，即便 token 完全正确', () => {
    // 绑定地址若被改成 0.0.0.0，这一条就是 API 面唯一还在挡局域网的东西。
    expect(deny({ remoteAddress: '192.168.1.5' })).toEqual({ status: 403, error: 'non_loopback_client' })
    expect(deny({ remoteAddress: undefined })).toEqual({ status: 403, error: 'non_loopback_client' })
  })

  it('排在最前：非回环 + 无 token 报的是 non_loopback_client', () => {
    expect(deny({ remoteAddress: '192.168.1.5', authorization: undefined }).error).toBe('non_loopback_client')
  })
})

describe('第三道：Host 与 Origin', () => {
  it('DNS rebinding：Host 是攻击者域名 → 403，即便 Origin 看起来同源', () => {
    // rebinding 下浏览器认为攻击者页面与我们同源，Origin 因此失去意义；Host 是唯一还说真话的头。
    expect(deny({ host: 'evil.com:3210', origin: 'http://evil.com:3210' }))
      .toEqual({ status: 403, error: 'forbidden_host' })
    // 同源 GET 压根不发 Origin，只剩 Host 能挡。
    expect(deny({ host: 'evil.com:3210', origin: undefined })).toEqual({ status: 403, error: 'forbidden_host' })
  })

  it('跨站发起：Origin 是别人 → 403', () => {
    expect(deny({ origin: 'http://evil.com' })).toEqual({ status: 403, error: 'forbidden_origin' })
    expect(deny({ origin: 'null' })).toEqual({ status: 403, error: 'forbidden_origin' })
    expect(deny({ origin: `http://127.0.0.1:${PORT + 1}` })).toEqual({ status: 403, error: 'forbidden_origin' })
  })

  it('跨站请求即便带着正确 token 也拒，且拒在 token 之前', () => {
    // 顺序是刻意的：跨站请求拿不到任何「token 对不对」的回音。
    expect(deny({ origin: 'http://evil.com', authorization: 'Bearer wrong' }))
      .toEqual({ status: 403, error: 'forbidden_origin' })
  })

  it('Host 缺席 → 403', () => {
    expect(deny({ host: undefined })).toEqual({ status: 403, error: 'forbidden_host' })
  })
})

describe('health 豁免', () => {
  it('无 token 的 health 放行——B1 的宿主探测发生在拿到 token 之前', () => {
    expect(authorizeApiRequest(facts({ pathname: HEALTH_PATH, authorization: undefined }), CONFIG))
      .toEqual({ kind: 'allow' })
  })

  it('豁免的只有 token：health 仍受对端地址与 Origin/Host 管辖', () => {
    expect(deny({ pathname: HEALTH_PATH, authorization: undefined, remoteAddress: '192.168.1.5' }))
      .toEqual({ status: 403, error: 'non_loopback_client' })
    expect(deny({ pathname: HEALTH_PATH, authorization: undefined, host: 'evil.com:3210' }))
      .toEqual({ status: 403, error: 'forbidden_host' })
    expect(deny({ pathname: HEALTH_PATH, authorization: undefined, origin: 'http://evil.com' }))
      .toEqual({ status: 403, error: 'forbidden_origin' })
  })

  it('豁免是精确路径匹配，不是前缀', () => {
    // `/api/health/../invoke/x` 这类形态在 requestPathname 那层就不归一，这里再钉一次：
    // 谁也不能靠「路径以 /api/health 开头」蹭掉 token。
    for (const pathname of [`${HEALTH_PATH}/`, `${HEALTH_PATH}x`, `${HEALTH_PATH}/../invoke/run_shell_command`]) {
      expect(deny({ pathname, authorization: undefined })).toEqual({ status: 401, error: 'missing_token' })
    }
  })
})
