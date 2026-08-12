// 事实合成的单测（D3a）：注册名 → 这次调用会不会起进程。
//
// 这里只钉合成规则本身（谁来回答「这个名字归哪个服务」、什么时候必须闭嘴）；
// 「答出来之后要不要暂停」是 core 的策略，见 packages/agent-core 的
// dangerousTools.mcpToolCall.test.ts。

import type { McpConnectTargetProbe } from '@web-agent/core/runtime/dangerousTools'
import { createMcpPlaceholderClaims } from '@web-agent/tools-mcp'
import type { Tool } from '@web-agent/core/tools/types'
import { describe, expect, it, vi } from 'vitest'
import { createMcpToolLaunchTargetProbe } from './toolLaunchTargetProbe'

const STDIO_COMMAND = 'npx -y @imported/from-untrusted-json'

function placeholder(name: string): Tool {
  return {
    name,
    runtime: 'server',
    skill: { description: '占位', content: '占位指南' },
    inputSchema: { type: 'object' },
    execute: () => ({ ok: true }),
  }
}

const connectTarget: McpConnectTargetProbe = (serverId) => {
  if (serverId === 'imported') {
    return { spawnsLocalProcess: true, command: STDIO_COMMAND, launchConsented: false }
  }
  if (serverId === 'docs') return { spawnsLocalProcess: false }
  return undefined
}

function makeProbe(options: {
  connected?: readonly string[]
  connectTarget?: McpConnectTargetProbe
} = {}) {
  const claims = createMcpPlaceholderClaims()
  claims.claim('imported', 'mcp__imported__run', placeholder('mcp__imported__run'))
  claims.claim('docs', 'mcp__docs__search', placeholder('mcp__docs__search'))
  const connected = new Set(options.connected ?? [])
  return {
    claims,
    connected,
    probe: createMcpToolLaunchTargetProbe({
      claims,
      connectTarget: options.connectTarget ?? connectTarget,
      isConnected: (serverId) => connected.has(serverId),
    }),
  }
}

describe('createMcpToolLaunchTargetProbe', () => {
  it('占位命中未连接的 stdio 服务 → 原样递出起进程事实（含那条命令行与确认状态）', () => {
    const { probe } = makeProbe()

    expect(probe('mcp__imported__run')).toEqual({
      spawnsLocalProcess: true,
      command: STDIO_COMMAND,
      launchConsented: false,
    })
  })

  it('占位命中未连接的 HTTP 服务 → 如实说「不起进程」，不擅自升级', () => {
    const { probe } = makeProbe()

    expect(probe('mcp__docs__search')).toEqual({ spawnsLocalProcess: false })
  })

  /**
   * 已连接 = 这次调用直接打在真实工具上。答成「会起进程」会让已连接服务的每次调用都在
   * Auto 模式下停下来问，属于回归。
   */
  it('服务已连接 → 闭嘴（即使占位登记还没被 reconcile 清干净）', () => {
    const { probe } = makeProbe({ connected: ['imported'] })

    expect(probe('mcp__imported__run')).toBeUndefined()
  })

  it('不是占位的名字一律闭嘴：真实工具、别的域的工具、不存在的名字', () => {
    const { probe } = makeProbe()

    expect(probe('mcp__github__create_issue')).toBeUndefined()
    expect(probe('write_file')).toBeUndefined()
    expect(probe('')).toBeUndefined()
  })

  it('占位登记被释放后（真实工具接管这个名字）立刻不再作答', () => {
    const { probe, claims } = makeProbe()
    expect(probe('mcp__imported__run')).toBeDefined()

    claims.release('mcp__imported__run')

    expect(probe('mcp__imported__run')).toBeUndefined()
  })

  /**
   * 名字归谁只认占位登记表：跨服务撞名时先到先得，真正注册着的是登记表里那一个。
   * 若改用缓存反查，这里会答出另一个服务的命令行——用户批准的就不是将要执行的那一条了。
   */
  it('serverId 只来自占位登记表：登记谁就查谁的连接目标', () => {
    const asked: string[] = []
    const { probe } = makeProbe({
      connectTarget: (serverId) => {
        asked.push(serverId)
        return { spawnsLocalProcess: true, command: `run ${serverId}` }
      },
    })

    expect(probe('mcp__docs__search')).toMatchObject({ command: 'run docs' })
    expect(asked).toEqual(['docs'])
  })

  it('连接目标探针答不上来时原样递出 undefined，不编造事实', () => {
    const { claims } = makeProbe()
    const probe = createMcpToolLaunchTargetProbe({
      claims,
      connectTarget: () => undefined,
      isConnected: () => false,
    })

    expect(probe('mcp__imported__run')).toBeUndefined()
  })

  it('少接任何一样都在装配期直接炸，不留一个永远答 undefined 的探针', () => {
    const claims = createMcpPlaceholderClaims()
    const message = 'createMcpToolLaunchTargetProbe requires claims, connectTarget and isConnected'

    expect(() => createMcpToolLaunchTargetProbe({ claims } as never)).toThrow(message)
    expect(() => createMcpToolLaunchTargetProbe({
      claims,
      connectTarget,
    } as never)).toThrow(message)
    expect(() => createMcpToolLaunchTargetProbe({
      connectTarget,
      isConnected: vi.fn(),
    } as never)).toThrow(message)
  })
})
