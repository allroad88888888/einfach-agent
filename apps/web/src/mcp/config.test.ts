import { describe, expect, it } from 'vitest'
import {
  buildPersistedMcpConfig,
  parseArgsText,
  sanitizePersistedMcpConfig,
  toManagerConfig,
} from './config'
import type { McpAddServerDraft } from './types'

const STDIO_DRAFT: McpAddServerDraft = {
  name: '本地工具',
  transport: 'stdio',
  url: '',
  command: 'npx',
  argsText: '-y\n@example/mcp-server',
  cwd: '',
  autoConnect: false,
}

/**
 * H1: stdio's `autoConnect` used to be hardcoded to `false` in three places
 * (buildPersistedMcpConfig, sanitizePersistedMcpConfig, and service.ts
 * hydrate). This file covers the two config.ts sites: the field must now be
 * an ordinary persistable boolean, round-tripping whatever value was given.
 * Whether a persisted `true` is ever allowed to actually start a local
 * process is a separate, runtime-level decision (service.ts), not something
 * these pure data-shaping functions should decide by silently overwriting
 * the value.
 */
describe('MCP config · stdio autoConnect is a normal persisted field (H1)', () => {
  it('buildPersistedMcpConfig honors a stdio draft with autoConnect: true', () => {
    const config = buildPersistedMcpConfig({ ...STDIO_DRAFT, autoConnect: true }, 'local-1')

    expect(config).toEqual({
      id: 'local-1',
      name: '本地工具',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@example/mcp-server'],
      autoConnect: true,
    })
  })

  it('buildPersistedMcpConfig still honors a stdio draft with autoConnect: false', () => {
    const config = buildPersistedMcpConfig({ ...STDIO_DRAFT, autoConnect: false }, 'local-2')

    expect(config.autoConnect).toBe(false)
  })

  it('sanitizePersistedMcpConfig reads a stored stdio autoConnect: true back as true', () => {
    const config = sanitizePersistedMcpConfig({
      id: 'local-3',
      name: '本地工具',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@example/mcp-server'],
      autoConnect: true,
    })

    expect(config?.autoConnect).toBe(true)
  })

  it('sanitizePersistedMcpConfig still defaults a missing or malformed stdio autoConnect to false', () => {
    const missing = sanitizePersistedMcpConfig({
      id: 'local-4',
      name: '本地工具',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@example/mcp-server'],
    })
    const malformed = sanitizePersistedMcpConfig({
      id: 'local-5',
      name: '本地工具',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@example/mcp-server'],
      autoConnect: 'yes',
    })

    expect(missing?.autoConnect).toBe(false)
    expect(malformed?.autoConnect).toBe(false)
  })
})

/**
 * C1: 白名单接受 headers（http）与 env（stdio）。这一层是**所有宿主共用**的净化，
 * 「凭据不进浏览器存储」是 localStorage 宿主自己的规则（persistence.ts），不在这里断供。
 */
describe('MCP config · 凭据字段进入持久化白名单（C1）', () => {
  it('保留 http 的 headers 与 stdio 的 env', () => {
    const http = sanitizePersistedMcpConfig({
      id: 'remote',
      name: '远程',
      transport: 'streamable-http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer sk-example' },
      autoConnect: true,
    })
    const stdio = sanitizePersistedMcpConfig({
      id: 'local',
      name: '本地工具',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@example/mcp-server'],
      env: { API_KEY: 'k-1' },
      autoConnect: false,
    })

    expect(http).toEqual({
      id: 'remote',
      name: '远程',
      transport: 'streamable-http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer sk-example' },
      autoConnect: true,
    })
    expect(stdio).toEqual({
      id: 'local',
      name: '本地工具',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@example/mcp-server'],
      env: { API_KEY: 'k-1' },
      autoConnect: false,
    })
  })

  it('凭据形状非法时整条丢弃，不留下一份「像是保存了但连不上」的配置', () => {
    expect(sanitizePersistedMcpConfig({
      id: 'remote',
      name: '远程',
      transport: 'streamable-http',
      url: 'https://example.com/mcp',
      headers: { 'X Api Key': 'v' },
      autoConnect: true,
    })).toBeUndefined()
    expect(sanitizePersistedMcpConfig({
      id: 'local',
      name: '本地工具',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@example/mcp-server'],
      env: { 'API-KEY': 'v' },
      autoConnect: false,
    })).toBeUndefined()
  })

  it('不接受写错传输的凭据字段：stdio 上的 headers、http 上的 env 都不落地', () => {
    expect(sanitizePersistedMcpConfig({
      id: 'local',
      name: '本地工具',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@example/mcp-server'],
      headers: { Authorization: 'Bearer secret' },
      autoConnect: false,
    })).toEqual({
      id: 'local',
      name: '本地工具',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@example/mcp-server'],
      autoConnect: false,
    })
    expect(sanitizePersistedMcpConfig({
      id: 'remote',
      name: '远程',
      transport: 'streamable-http',
      url: 'https://example.com/mcp',
      env: { API_KEY: 'secret' },
      autoConnect: false,
    })).toEqual({
      id: 'remote',
      name: '远程',
      transport: 'streamable-http',
      url: 'https://example.com/mcp',
      autoConnect: false,
    })
  })

  it('toManagerConfig 把两个字段透传进连接配置，并各复制一份', () => {
    const headers = { Authorization: 'Bearer sk-example' }
    const env = { API_KEY: 'k-1' }

    const http = toManagerConfig({
      id: 'remote',
      name: '远程',
      transport: 'streamable-http',
      url: 'https://example.com/mcp',
      headers,
      autoConnect: true,
    })
    const stdio = toManagerConfig({
      id: 'local',
      name: '本地工具',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@example/mcp-server'],
      env,
      launchConsent: { fingerprint: 'fp', approvedAt: 1 },
      autoConnect: true,
    })

    expect(http).toEqual({
      id: 'remote',
      name: '远程',
      transport: 'streamable-http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer sk-example' },
    })
    expect(stdio).toEqual({
      id: 'local',
      name: '本地工具',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@example/mcp-server'],
      env: { API_KEY: 'k-1' },
    })
    // 纯应用层的确认记录不该出现在协议侧的连接配置里。
    expect(stdio).not.toHaveProperty('launchConsent')
    // 复制而非共享引用：管理器会长期持有这份配置。
    expect((http as { headers?: object }).headers).not.toBe(headers)
    expect((stdio as { env?: object }).env).not.toBe(env)
  })

  it('启动参数里的疑似凭据仍然被拒，文案改为指引 env / headers 字段', () => {
    const result = parseArgsText('-y\n@example/mcp-server\n--token=secret')

    expect(result.args).toBeUndefined()
    expect(result.error).toContain('启动参数不能包含疑似 token')
    expect(result.error).toContain('env')
    expect(result.error).toContain('headers')
    expect(parseArgsText('--api-key\nsk-secret').error).toBeTruthy()
    expect(parseArgsText('-y\n@example/mcp-server').args).toEqual([
      '-y',
      '@example/mcp-server',
    ])
  })
})
