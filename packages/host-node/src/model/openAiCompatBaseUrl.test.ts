// 登记式 origin 的判据：openai-compat 用什么替代「精确匹配一个已知端点」
// ---------------------------------------------------------------------------
// 这一组是本域安全性在 openai-compat 这一家上的全部。前三家靠常量 origin，它靠这条判据 +
// 「只放行用户显式登记的那一条」。判据松一格，这一层就退化成一个开放代理。
import { describe, expect, it } from 'vitest'
import {
  isLoopbackHostname,
  normalizeOpenAiCompatBaseUrl,
  requireOpenAiCompatBaseUrl,
} from './openAiCompatBaseUrl'

describe('放行的形态', () => {
  it.each([
    // https 到任意主机：用户显式登记的第三方兼容端点，这是它最常见的形态。
    ['https://api.example.com', 'https://api.example.com'],
    ['https://api.example.com/v1', 'https://api.example.com/v1'],
    ['https://api.example.com:8443/v1', 'https://api.example.com:8443/v1'],
    // 明文 http **只**给回环：自建网关跑在本机是这一家的典型形态。
    ['http://127.0.0.1:8080/v1', 'http://127.0.0.1:8080/v1'],
    ['http://localhost:11434/v1', 'http://localhost:11434/v1'],
    ['http://[::1]:8080', 'http://[::1]:8080'],
    // 归一化：末尾斜杠与首尾空白都要消掉，否则 `origin + path` 会拼出双斜杠，
    // 同一个端点在配置里就有了两种写法。
    ['https://api.example.com/v1/', 'https://api.example.com/v1'],
    ['  https://api.example.com/v1  ', 'https://api.example.com/v1'],
    ['https://api.example.com/', 'https://api.example.com'],
    // WHATWG 会把 `127.1` 归一成四段，判回环看的是归一后的形态。
    ['http://127.1:9000', 'http://127.0.0.1:9000'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeOpenAiCompatBaseUrl(input)).toBe(expected)
  })
})

describe('拒绝的形态', () => {
  it('明文 http 打到非回环主机一律拒绝——Key 走 Authorization 头明文上行', () => {
    for (const value of [
      'http://api.example.com/v1',
      'http://192.168.1.10:8080/v1',
      'http://10.0.0.5/v1',
      // 名字里带 localhost 不等于是 localhost。
      'http://localhost.example.com/v1',
      'http://notlocalhost/v1',
      'http://localhost.localdomain/v1',
    ]) {
      expect(normalizeOpenAiCompatBaseUrl(value)).toBeUndefined()
    }
  })

  it('内嵌用户名密码一律拒绝——它会变成第二个 Authorization 头，且原样躺在配置文件里', () => {
    expect(normalizeOpenAiCompatBaseUrl('https://user:pass@api.example.com/v1')).toBeUndefined()
    expect(normalizeOpenAiCompatBaseUrl('https://user@api.example.com/v1')).toBeUndefined()
  })

  it('query 与 fragment 一律拒绝——base 里带 ? 会让拼接结果不再是 chat 端点', () => {
    expect(normalizeOpenAiCompatBaseUrl('https://api.example.com/v1?key=leak')).toBeUndefined()
    expect(normalizeOpenAiCompatBaseUrl('https://api.example.com/v1#frag')).toBeUndefined()
  })

  it('非 http(s) 协议一律拒绝', () => {
    for (const value of [
      'file:///etc/passwd',
      'ftp://api.example.com',
      'javascript:alert(1)',
      'data:text/plain,hi',
      'ws://127.0.0.1:8080',
    ]) {
      expect(normalizeOpenAiCompatBaseUrl(value)).toBeUndefined()
    }
  })

  it('压根不是绝对 URL 的一律拒绝（相对路径没有 origin 可言）', () => {
    for (const value of ['', '   ', '/v1', 'api.example.com/v1', 'https://', '://x']) {
      expect(normalizeOpenAiCompatBaseUrl(value)).toBeUndefined()
    }
  })

  it('超长值拒绝：配置里的畸形值不该一路带到 fetch', () => {
    expect(normalizeOpenAiCompatBaseUrl(`https://a.example.com/${'x'.repeat(512)}`))
      .toBeUndefined()
  })
})

describe('回环判据本身', () => {
  it.each(['localhost', '127.0.0.1', '127.9.9.9', '[::1]'])('%s 是回环', (hostname) => {
    expect(isLoopbackHostname(hostname)).toBe(true)
  })

  it.each([
    '127.0.0.1.example.com',
    'localhost.',
    '0.0.0.0',
    '192.168.0.1',
    '[::2]',
    'example.com',
  ])('%s 不是回环', (hostname) => {
    expect(isLoopbackHostname(hostname)).toBe(false)
  })
})

describe('受控失败形态', () => {
  it('不合规时抛本域的 invalidBaseUrl，且**不回显那个地址**', () => {
    const secretish = 'https://user:pass@evil.example.com/v1'
    let thrown: unknown
    try {
      requireOpenAiCompatBaseUrl(secretish)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(Error)
    expect((thrown as { reason?: string }).reason).toBe('target-not-allowed')
    expect((thrown as Error).message).toBe('模型接入点地址未获允许')
    expect(String(thrown)).not.toContain('evil.example.com')
    expect(String(thrown)).not.toContain('pass')
  })

  it('合规时原样返回归一化结果', () => {
    expect(requireOpenAiCompatBaseUrl('https://api.example.com/v1/')).toBe('https://api.example.com/v1')
  })
})
