import { describe, expect, it } from 'vitest'
import {
  sanitizeMcpEnv,
  sanitizeMcpHeaders,
  stripMcpCredentialFields,
} from './credentialFields'
import type { PersistedMcpServerConfig } from './types'

describe('MCP 凭据字段的净化（C1）', () => {
  it('保留合法的认证头，包括 Authorization 这类敏感键', () => {
    const result = sanitizeMcpHeaders({
      Authorization: 'Bearer sk-example',
      'X-Api-Key': 'k-1',
    })

    // 敏感键名恰恰是这个字段存在的理由，不能套用启动参数那套秘密键名拒绝。
    expect(result).toEqual({
      ok: true,
      value: { Authorization: 'Bearer sk-example', 'X-Api-Key': 'k-1' },
    })
  })

  it('把缺失、null 和空表都当作「没有凭据」，不落地空对象', () => {
    expect(sanitizeMcpHeaders(undefined)).toEqual({ ok: true })
    expect(sanitizeMcpHeaders(null)).toEqual({ ok: true })
    expect(sanitizeMcpHeaders({})).toEqual({ ok: true })
    expect(sanitizeMcpEnv({})).toEqual({ ok: true })
  })

  it('拒绝非 HTTP token 的字段名', () => {
    expect(sanitizeMcpHeaders({ 'X Api Key': 'v' }).ok).toBe(false)
    expect(sanitizeMcpHeaders({ 'X-Api:Key': 'v' }).ok).toBe(false)
    expect(sanitizeMcpHeaders({ '认证': 'v' }).ok).toBe(false)
    expect(sanitizeMcpHeaders({ [`X-${'a'.repeat(200)}`]: 'v' }).ok).toBe(false)
  })

  it('拒绝含控制字符的值：CR/LF 是请求头注入的入口', () => {
    expect(sanitizeMcpHeaders({ Authorization: 'Bearer a\r\nX-Injected: 1' }).ok).toBe(false)
    expect(sanitizeMcpEnv({ TOKEN: 'a\u0000b' }).ok).toBe(false)
  })

  it('拒绝非字符串的值、数组和超限的表', () => {
    expect(sanitizeMcpHeaders({ Authorization: 42 }).ok).toBe(false)
    expect(sanitizeMcpHeaders({ Authorization: { nested: 'v' } }).ok).toBe(false)
    expect(sanitizeMcpHeaders([['Authorization', 'v']]).ok).toBe(false)
    expect(sanitizeMcpHeaders({ Authorization: 'a'.repeat(4_097) }).ok).toBe(false)
    expect(sanitizeMcpEnv(
      Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`K_${i}`, 'v'])),
    ).ok).toBe(false)
  })

  it('环境变量名按 POSIX 校验', () => {
    expect(sanitizeMcpEnv({ API_KEY: 'k', _private: 'v' })).toEqual({
      ok: true,
      value: { API_KEY: 'k', _private: 'v' },
    })
    expect(sanitizeMcpEnv({ '1TOKEN': 'v' }).ok).toBe(false)
    expect(sanitizeMcpEnv({ 'API-KEY': 'v' }).ok).toBe(false)
    expect(sanitizeMcpEnv({ 'PATH=X': 'v' }).ok).toBe(false)
  })

  it('值原样保留，不做 trim、不做秘密探测', () => {
    // 前后空白可能是凭据的一部分；「长得像 token」在这里是正常的。
    expect(sanitizeMcpEnv({ TOKEN: ' sk-live-abc ' })).toEqual({
      ok: true,
      value: { TOKEN: ' sk-live-abc ' },
    })
  })

  it('__proto__ 是合法的 HTTP token，但不能污染原型', () => {
    // 必须用 JSON.parse 造：对象字面量里的 __proto__ 是设置原型的语法，造不出这个自有属性。
    // 而读配置文件走的正是 JSON.parse。
    const result = sanitizeMcpHeaders(JSON.parse('{"__proto__":"polluted"}'))

    expect(result.ok).toBe(true)
    const value = (result as { value?: Record<string, string> }).value
    expect(Object.getOwnPropertyDescriptor(value, '__proto__')?.value).toBe('polluted')
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

describe('stripMcpCredentialFields', () => {
  it('剥掉 headers / env，其余字段原样保留', () => {
    const http: PersistedMcpServerConfig = {
      id: 'http',
      name: '远程',
      transport: 'streamable-http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer secret' },
      autoConnect: true,
    }
    const stdio: PersistedMcpServerConfig = {
      id: 'stdio',
      name: '本地',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@example/mcp-server'],
      cwd: '/workspace',
      env: { API_KEY: 'secret' },
      launchConsent: { fingerprint: 'fp', approvedAt: 1 },
      autoConnect: false,
    }

    expect(stripMcpCredentialFields(http)).toEqual({
      id: 'http',
      name: '远程',
      transport: 'streamable-http',
      url: 'https://example.com/mcp',
      autoConnect: true,
    })
    expect(stripMcpCredentialFields(stdio)).toEqual({
      id: 'stdio',
      name: '本地',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@example/mcp-server'],
      cwd: '/workspace',
      launchConsent: { fingerprint: 'fp', approvedAt: 1 },
      autoConnect: false,
    })
  })

  it('没有凭据字段时原样返回同一个对象', () => {
    const config: PersistedMcpServerConfig = {
      id: 'http',
      name: '远程',
      transport: 'streamable-http',
      url: 'https://example.com/mcp',
      autoConnect: false,
    }

    expect(stripMcpCredentialFields(config)).toBe(config)
  })
})
