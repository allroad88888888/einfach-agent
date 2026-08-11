import { describe, expect, it } from 'vitest'
import {
  classifyToolRisk,
  MCP_CONNECT_TOOL_NAME,
  type McpConnectTargetProbe,
} from './dangerousTools'

describe('classifyToolRisk', () => {
  it.each([
    'rm -rf *',
    'sudo rm -r -f /',
    'cd /tmp && rm -Rf "./*"',
    'rm -rf $HOME',
    'rm -rf "$PWD"',
  ])('把大范围递归强删判为 critical：%s', (command) => {
    expect(classifyToolRisk('shell_macos', { command }).level).toBe('critical')
  })

  it('把删除 workspace 根目录或其父目录判为 critical', () => {
    expect(classifyToolRisk(
      'shell_linux',
      { command: 'rm -rf /Volumes/work/ai' },
      { workspaceRoot: '/Volumes/work/ai/web-agent' },
    ).level).toBe('critical')
  })

  it.each([
    'pwd',
    'pnpm test',
    'rm -rf ./dist',
  ])('普通 shell 仍为 dangerous：%s', (command) => {
    expect(classifyToolRisk('shell_macos', { command }).level).toBe('dangerous')
  })

  it.each([
    'rm note.txt',
    'sudo rm -f build.log',
    'cd tmp && rm -r cache',
    '/bin/rm generated.txt',
    'env rm generated.txt',
    "sh -c 'rm generated.txt'",
  ])('普通命令行 rm 标记不可撤回，但不强制打断 Auto：%s', (command) => {
    expect(classifyToolRisk('shell_macos', { command })).toMatchObject({
      level: 'dangerous',
      irreversible: true,
    })
    expect(classifyToolRisk('shell_macos', { command }).requiresConfirmation).toBeUndefined()
  })

  it('可恢复 delete_path 是普通 dangerous，Auto 可直接执行', () => {
    expect(classifyToolRisk('delete_path', { path: 'build', recursive: true })).toEqual({
      level: 'dangerous',
    })
  })

  it('外部 MCP 工具作为 dangerous 交由授权模式决定是否确认', () => {
    expect(classifyToolRisk('mcp__github__create_issue', { title: 'test' })).toEqual({
      level: 'dangerous',
    })
  })

  it('直接覆写设备判为 critical，非变更工具为 safe', () => {
    expect(classifyToolRisk('shell_linux', { command: 'dd if=/dev/zero of=/dev/sda' }).level).toBe('critical')
    expect(classifyToolRisk('read_file', { path: '/tmp/a' }).level).toBe('safe')
  })

  it('PowerShell 宽范围递归强删判为 critical', () => {
    expect(classifyToolRisk(
      'shell_powershell',
      { command: 'Remove-Item -Recurse -Force *' },
    ).level).toBe('critical')
  })
})

// 连接 MCP 服务：同一个工具名、同一份参数形状，风险完全由 serverId 指向的落地方式决定。
describe('classifyToolRisk · connect_mcp_server 按 serverId 分级', () => {
  const STDIO_COMMAND = 'npx -y @modelcontextprotocol/server-filesystem /Users/me/notes'

  const probe: McpConnectTargetProbe = (serverId) => {
    if (serverId === 'local-fs') {
      return { spawnsLocalProcess: true, command: STDIO_COMMAND, launchConsented: true }
    }
    if (serverId === 'unseen-fs') {
      return { spawnsLocalProcess: true, command: STDIO_COMMAND, launchConsented: false }
    }
    if (serverId === 'quiet-stdio') return { spawnsLocalProcess: true }
    if (serverId === 'remote-docs') return { spawnsLocalProcess: false }
    return undefined
  }

  it('stdio 服务 → dangerous，且确认理由里带上将要执行的命令', () => {
    const risk = classifyToolRisk(
      MCP_CONNECT_TOOL_NAME,
      { serverId: 'local-fs' },
      { mcpConnectTarget: probe },
    )
    expect(risk.level).toBe('dangerous')
    expect(risk.reason).toContain(STDIO_COMMAND)
  })

  // F8：确认过的命令行才与 shell_* 同级（Auto 已接受「模型当场构造的命令」这份风险）。
  it('已确认过的 stdio → 普通 dangerous，不强制打断 Auto', () => {
    const risk = classifyToolRisk(
      MCP_CONNECT_TOOL_NAME,
      { serverId: 'local-fs' },
      { mcpConnectTarget: probe },
    )
    expect(risk.requiresConfirmation).toBeUndefined()
  })

  /**
   * F8 的核心判据。从没被人看过的启动命令，Auto 模式也必须先摆到用户面前：
   * 用户以为自己只是存了一份配置（可能是从不可信来源导入的），而这一步会真的执行它。
   */
  it('从未确认过的 stdio → requiresConfirmation，Auto 模式也要暂停', () => {
    const risk = classifyToolRisk(
      MCP_CONNECT_TOOL_NAME,
      { serverId: 'unseen-fs' },
      { mcpConnectTarget: probe },
    )
    expect(risk.level).toBe('dangerous')
    expect(risk.requiresConfirmation).toBe(true)
    expect(risk.reason).toContain('还没有确认过')
    expect(risk.reason).toContain(STDIO_COMMAND)
  })

  it('宿主没报告确认状态（字段缺省）一律按未确认处理', () => {
    expect(classifyToolRisk(
      MCP_CONNECT_TOOL_NAME,
      { serverId: 'quiet-stdio' },
      { mcpConnectTarget: probe },
    ).requiresConfirmation).toBe(true)
  })

  it('stdio 但宿主给不出命令行 → 仍然 dangerous，理由说明会起子进程', () => {
    const risk = classifyToolRisk(
      MCP_CONNECT_TOOL_NAME,
      { serverId: 'quiet-stdio' },
      { mcpConnectTarget: probe },
    )
    expect(risk.level).toBe('dangerous')
    expect(risk.reason).toContain('子进程')
  })

  it('超长命令行截断后仍能看出是什么命令，且不整段灌进确认卡片', () => {
    const longCommand = `node ${'a'.repeat(400)}.js`
    const risk = classifyToolRisk(
      MCP_CONNECT_TOOL_NAME,
      { serverId: 'x' },
      { mcpConnectTarget: () => ({ spawnsLocalProcess: true, command: longCommand }) },
    )
    expect(risk.reason).toContain('node aaa')
    expect(risk.reason).toContain('…')
    expect(risk.reason?.length).toBeLessThan(longCommand.length)
  })

  it('HTTP 服务 → safe：只发网络请求，不打扰用户', () => {
    expect(classifyToolRisk(
      MCP_CONNECT_TOOL_NAME,
      { serverId: 'remote-docs' },
      { mcpConnectTarget: probe },
    )).toEqual({ level: 'safe' })
  })

  // 默认从严：任何「查不到 / 说不清」都不能落到 safe，否则一次静默的本机进程启动就漏过去了。
  it.each([
    ['宿主根本没接探针', undefined, { serverId: 'local-fs' } as unknown],
    ['整个 context 缺失', undefined, { serverId: 'local-fs' } as unknown],
    ['探针不认识这个 serverId', probe, { serverId: 'never-configured' } as unknown],
    ['serverId 不是字符串（连接配置对象）', probe, { serverId: { transport: 'stdio' } } as unknown],
    ['serverId 为空白', probe, { serverId: '   ' } as unknown],
    ['缺 serverId', probe, {} as unknown],
    ['args 不是对象', probe, 'local-fs' as unknown],
    ['args 是数组', probe, ['local-fs'] as unknown],
    ['args 为 null', probe, null as unknown],
  ])('信息缺失一律 dangerous 且必须暂停：%s', (_label, injected, args) => {
    // 「查不到」也包含「查不到它确认过没有」——所以不止 dangerous，还要打断 Auto。
    expect(classifyToolRisk(
      MCP_CONNECT_TOOL_NAME,
      args,
      { mcpConnectTarget: injected },
    )).toMatchObject({ level: 'dangerous', requiresConfirmation: true })
  })

  it('完全不传 context 时也是 dangerous 且必须暂停（不是 safe）', () => {
    expect(classifyToolRisk(MCP_CONNECT_TOOL_NAME, { serverId: 'remote-docs' }))
      .toMatchObject({ level: 'dangerous', requiresConfirmation: true })
  })

  it('探针抛错不穿透风险判定，且不被算成不危险', () => {
    expect(classifyToolRisk(
      MCP_CONNECT_TOOL_NAME,
      { serverId: 'local-fs' },
      { mcpConnectTarget: () => { throw new Error('manager 挂了') } },
    )).toMatchObject({ level: 'dangerous', requiresConfirmation: true })
  })

  it('是完整工具名等值匹配，不是前缀特判', () => {
    expect(classifyToolRisk(
      `${MCP_CONNECT_TOOL_NAME}_v2`,
      { serverId: 'local-fs' },
      { mcpConnectTarget: probe },
    ).level).toBe('safe')
  })

  it('连接工具不进 DANGEROUS_TOOLS：连接能力不可授权给子 agent', async () => {
    const { isDelegatableDangerousTool } = await import('./dangerousTools')
    expect(isDelegatableDangerousTool(MCP_CONNECT_TOOL_NAME)).toBe(false)
  })
})
