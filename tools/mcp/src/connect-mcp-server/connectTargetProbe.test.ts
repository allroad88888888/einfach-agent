import { describe, expect, it } from 'vitest'
import {
  MCP_CONNECT_TOOL_NAME as CORE_MCP_CONNECT_TOOL_NAME,
  classifyToolRisk,
} from '@web-agent/core/runtime/dangerousTools'
import type { McpServerConfig, McpServerSnapshot } from '../types'
import { MCP_CONNECT_TOOL_NAME } from './connect-mcp-server'
import { createMcpConnectTargetProbe } from './connectTargetProbe'

function snapshot(config: McpServerConfig): McpServerSnapshot {
  return { id: config.id, config, status: 'disconnected', tools: [] }
}

function managerWith(...configs: McpServerConfig[]) {
  const records = new Map(configs.map((config) => [config.id, snapshot(config)]))
  return { get: (serverId: string) => records.get(serverId) }
}

const STDIO: McpServerConfig = {
  id: 'local-fs',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/Users/me/notes'],
  env: { TOKEN: 'SECRET' },
  cwd: '/Users/me',
}

const HTTP: McpServerConfig = {
  id: 'remote-docs',
  transport: 'streamable-http',
  url: 'https://mcp.example.test',
  headers: { authorization: 'Bearer SECRET_TOKEN' },
}

describe('createMcpConnectTargetProbe', () => {
  it('stdio 服务：报告会起本机子进程，并给出完整命令行', () => {
    const probe = createMcpConnectTargetProbe(managerWith(STDIO))

    expect(probe('local-fs')).toEqual({
      spawnsLocalProcess: true,
      command: 'npx -y @modelcontextprotocol/server-filesystem /Users/me/notes',
    })
  })

  it('streamable-http 服务：不起本机进程', () => {
    const probe = createMcpConnectTargetProbe(managerWith(HTTP))

    expect(probe('remote-docs')).toEqual({ spawnsLocalProcess: false })
  })

  it('未登记的 serverId 返回 undefined，交回 core 的从严默认', () => {
    expect(createMcpConnectTargetProbe(managerWith(STDIO, HTTP))('ghost')).toBeUndefined()
  })

  it('绝不回传连接配置本身（url / headers / env 可能含凭据）', () => {
    const probe = createMcpConnectTargetProbe(managerWith(STDIO, HTTP))
    const serialized = JSON.stringify([probe('local-fs'), probe('remote-docs')])

    expect(serialized).not.toContain('SECRET')
    expect(serialized).not.toContain('mcp.example.test')
  })

  it('宿主接错线时在装配期就抛，不返回一个到调用时才崩的探针', () => {
    expect(() => createMcpConnectTargetProbe(undefined as never)).toThrow(
      'createMcpConnectTargetProbe requires an MCP client manager',
    )
    expect(() => createMcpConnectTargetProbe({} as never)).toThrow(
      'createMcpConnectTargetProbe requires an MCP client manager',
    )
  })
})

/**
 * 跨包锁定。core 侧的风险策略靠【完整工具名等值匹配】认出连接工具，而工具名的真身在本包
 * （core 不能反向依赖 tools-mcp，只能各写一份常量）。本包这侧能同时看到两个常量 ——
 * 一旦有人改了工具名却没同步 core，那道确认门会静默失效，这个测试就是拦它的。
 */
describe('连接工具名在 core 与 tools-mcp 之间保持一致', () => {
  it('两侧常量相同', () => {
    expect(MCP_CONNECT_TOOL_NAME).toBe(CORE_MCP_CONNECT_TOOL_NAME)
  })

  it('用真实工具名 + 真实探针跑一遍 core 的分级：stdio 要确认、HTTP 放行', () => {
    const mcpConnectTarget = createMcpConnectTargetProbe(managerWith(STDIO, HTTP))

    expect(classifyToolRisk(
      MCP_CONNECT_TOOL_NAME,
      { serverId: 'local-fs' },
      { mcpConnectTarget },
    )).toMatchObject({ level: 'dangerous' })
    expect(classifyToolRisk(
      MCP_CONNECT_TOOL_NAME,
      { serverId: 'remote-docs' },
      { mcpConnectTarget },
    )).toEqual({ level: 'safe' })
    expect(classifyToolRisk(
      MCP_CONNECT_TOOL_NAME,
      { serverId: 'ghost' },
      { mcpConnectTarget },
    ).level).toBe('dangerous')
  })
})
