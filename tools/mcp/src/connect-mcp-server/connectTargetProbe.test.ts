import { describe, expect, it } from 'vitest'
import {
  MCP_CONNECT_TOOL_NAME as CORE_MCP_CONNECT_TOOL_NAME,
  classifyToolRisk,
} from '@einfach-agent/core/runtime/dangerousTools'
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

const STDIO_COMMAND_LINE = 'npx -y @modelcontextprotocol/server-filesystem /Users/me/notes'

describe('createMcpConnectTargetProbe', () => {
  it('stdio 服务：报告会起本机子进程，并给出完整命令行', () => {
    const probe = createMcpConnectTargetProbe(managerWith(STDIO))

    expect(probe('local-fs')).toEqual({
      spawnsLocalProcess: true,
      command: STDIO_COMMAND_LINE,
      // 宿主没接确认这根线 = 一律未确认（F8 的从严默认）。
      launchConsented: false,
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

  // F8：起进程确认记在 app 层的持久化配置上，本包只负责把宿主的答案原样带给 core。
  it('宿主报告这条命令行确认过 → launchConsented: true，并被问到的正是将要执行的那条', () => {
    const asked: Array<[string, string]> = []
    const probe = createMcpConnectTargetProbe(managerWith(STDIO), {
      isLaunchConsented: (serverId, commandLine) => {
        asked.push([serverId, commandLine])
        return true
      },
    })

    expect(probe('local-fs')).toEqual({
      spawnsLocalProcess: true,
      command: STDIO_COMMAND_LINE,
      launchConsented: true,
    })
    expect(asked).toEqual([['local-fs', STDIO_COMMAND_LINE]])
  })

  it('宿主报告没确认过 → launchConsented: false', () => {
    const probe = createMcpConnectTargetProbe(managerWith(STDIO), {
      isLaunchConsented: () => false,
    })

    expect(probe('local-fs')?.launchConsented).toBe(false)
  })

  it('确认记录读崩了不算「已确认」，也不把异常抛给风险判定', () => {
    const probe = createMcpConnectTargetProbe(managerWith(STDIO), {
      isLaunchConsented: () => {
        throw new Error('配置存储挂了')
      },
    })

    expect(probe('local-fs')?.launchConsented).toBe(false)
  })

  it('HTTP 服务不谈确认：起不了进程，就不挂这个没有含义的字段', () => {
    const probe = createMcpConnectTargetProbe(managerWith(HTTP), {
      isLaunchConsented: () => false,
    })

    expect(probe('remote-docs')).toEqual({ spawnsLocalProcess: false })
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
    const mcpConnectTarget = createMcpConnectTargetProbe(managerWith(STDIO, HTTP), {
      isLaunchConsented: () => true,
    })

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

  // F8 的跨包锁定：未确认那一路必须一直传到 core 的 requiresConfirmation，
  // 那个字段才是「Auto 模式也要暂停」的开关。
  it('未确认的 stdio 一路传到 core：requiresConfirmation；确认过则不打断 Auto', () => {
    const unconsented = createMcpConnectTargetProbe(managerWith(STDIO, HTTP))
    const consented = createMcpConnectTargetProbe(managerWith(STDIO, HTTP), {
      isLaunchConsented: () => true,
    })

    expect(classifyToolRisk(
      MCP_CONNECT_TOOL_NAME,
      { serverId: 'local-fs' },
      { mcpConnectTarget: unconsented },
    )).toMatchObject({ level: 'dangerous', requiresConfirmation: true })
    expect(classifyToolRisk(
      MCP_CONNECT_TOOL_NAME,
      { serverId: 'local-fs' },
      { mcpConnectTarget: consented },
    ).requiresConfirmation).toBeUndefined()
  })
})
