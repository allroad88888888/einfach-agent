// S4-B 危险工具集判定 —— 哪些 server 工具在执行前需要用户确认。
// ---------------------------------------------------------------------------
// 「危险」= 任意本机执行或直接变更磁盘的 server 工具：本机 shell（macos/linux/powershell）、
// 写文件、打补丁。只读工具不在内 —— 不需确认。
//
// run_task 有执行项目脚本的风险，但它不是任意 shell：只接受固定 kind，后端固定 argv、workspace、
// timeout 和输出上限。这里刻意不纳入确认集，保留「改代码 → 跑验证」的最小闭环。
// 单点定义，供 modelRun tool 循环在「分发工具前」判定是否暂停等确认（镜像 ask_user 暂停）。

// 危险（变更类）server 工具名集合。新增变更类工具时在这里补一行即可。
export const DANGEROUS_TOOLS: ReadonlySet<string> = new Set([
  'shell_macos',
  'shell_linux',
  'shell_powershell',
  'write_file',
  'apply_patch',
  'delete_path',
  'copy_path',
  'move_path',
  'revert_workspace_change',
])

// 简介：MCP 工具由外部服务动态提供，按危险工具处理。
export function isMcpTool(name: string): boolean {
  return name.startsWith('mcp__')
}

/**
 * 「按需连接一个已配置 MCP 服务」的工具名。
 *
 * 【为什么 core 里会出现一个具体工具名】DANGEROUS_TOOLS 里本来就写着 shell_macos / write_file
 *   等具体工具名 ——「哪些调用要拦」是 core 的策略，工具名就是策略的一部分。这里同样是【完整
 *   工具名的等值匹配】，不是 `mcp__` 那种前缀特判：前缀会把任何以它开头的名字一并卷进来，
 *   等值只认这一个。
 * 【为什么不是 import 过来】名字的真身在 tools/mcp，依赖方向是 agent-core ← tools-*，core 不能
 *   反向依赖它。两边一致由 tools/mcp 侧的锁定测试守住（connectTargetProbe.test.ts）。
 */
export const MCP_CONNECT_TOOL_NAME = 'connect_mcp_server'

// 简介：某工具名是否属于「执行前需用户确认」的危险工具集。
export function isDangerousTool(name: string): boolean {
  return DANGEROUS_TOOLS.has(name) || isMcpTool(name)
}

// 简介：只有内建危险工具可被显式授权给子 agent；MCP 工具必须留在父级执行边界。
export function isDelegatableDangerousTool(name: string): boolean {
  return DANGEROUS_TOOLS.has(name)
}

export type ToolRisk = 'safe' | 'dangerous' | 'critical'

export interface ToolRiskAssessment {
  level: ToolRisk
  reason?: string
  /** This operation must pause even when the session is in Auto mode. */
  requiresConfirmation?: boolean
  /** The runtime cannot provide a workspace change set for this operation. */
  irreversible?: boolean
}

/**
 * 宿主对「连接某个已配置 MCP 服务」会落到哪里的描述。
 *
 * 只回答风险判定用得上的那点事实，不回传连接配置本身（url / headers / env 可能含凭据）。
 */
export interface McpConnectTarget {
  /** 连接它是否会在用户本机拉起子进程（stdio 传输）。 */
  spawnsLocalProcess: boolean
  /** 本机将要执行的命令行；仅 spawnsLocalProcess 为 true 时有意义，用于确认提示。 */
  command?: string
  /**
   * 用户此前是否【亲眼确认过】这条将要执行的命令行（宿主自己的起进程确认记录）。
   *
   * 缺省即未确认。宿主答不上来时必须当作没确认过：一份从不可信来源导入、用户从未点开过
   * 的配置，不能因为这个可选字段没接线就在 Auto 模式下被静默执行。
   */
  launchConsented?: boolean
}

/**
 * serverId → 落地描述的探针，由装配 MCP manager 的宿主注入。
 * 返回 undefined = 宿主答不上来（未登记的 id、未接线、未知传输方式）—— 由 core 按从严处理。
 */
export type McpConnectTargetProbe = (serverId: string) => McpConnectTarget | undefined

/** classifyToolRisk 的注入面：core 拿不到的运行时事实统统从这里进来。 */
export interface ToolRiskContext {
  workspaceRoot?: string
  mcpConnectTarget?: McpConnectTargetProbe
}

function stringFromArgs(args: unknown, key: string): string {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return ''
  const value = (args as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : ''
}

function commandFromArgs(args: unknown): string {
  return stringFromArgs(args, 'command')
}

function unquote(value: string): string {
  const trimmed = value.trim()
  if (
    trimmed.length >= 2
    && ((trimmed.startsWith('"') && trimmed.endsWith('"'))
      || (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function isBroadDeleteTarget(value: string, workspaceRoot?: string): boolean {
  const target = unquote(value).replace(/\/+$/, '') || '/'
  const broadTargets = new Set([
    '/',
    '/*',
    '.',
    './*',
    '..',
    '../*',
    '*',
    '~',
    '~/*',
    '$HOME',
    '$HOME/*',
    '${HOME}',
    '${HOME}/*',
    '$PWD',
    '$PWD/*',
    '${PWD}',
    '${PWD}/*',
  ])
  if (broadTargets.has(target)) return true

  const root = workspaceRoot?.replace(/\/+$/, '')
  return Boolean(root && (target === root || root.startsWith(`${target}/`)))
}

function criticalUnixDelete(command: string, workspaceRoot?: string): boolean {
  for (const part of command.split(/(?:&&|\|\||[;\n])/)) {
    const match = part.match(
      /(?:^|\s)(?:(?:sudo|command|env)\s+)*(?:(?:\/usr)?\/bin\/)?rm\s+((?:-[^\s]+\s+)+)([^|;&]+)/i,
    )
    if (!match) continue
    const flags = match[1].replace(/\s/g, '').toLowerCase()
    if (!flags.includes('r') || !flags.includes('f')) continue
    const targets = match[2].trim().split(/\s+/).filter((token) => !token.startsWith('-'))
    if (targets.some((target) => isBroadDeleteTarget(target, workspaceRoot))) return true
  }
  return false
}

function criticalPowerShellDelete(command: string): boolean {
  if (!/\b(?:remove-item|rm|del)\b/i.test(command)) return false
  if (!/(?:-recurse\b|-r\b)/i.test(command) || !/(?:-force\b|-fo\b)/i.test(command)) return false
  return /(?:^|\s)(?:["']?(?:[a-z]:\\|\\|\*|\.|~|\$home)(?:\\?\*)?["']?)(?:\s|$)/i.test(command)
}

export function commandUsesPermanentDelete(name: string, args: unknown): boolean {
  if (!name.startsWith('shell_')) return false
  const command = commandFromArgs(args)
  if (name === 'shell_powershell') {
    return /(?:^|[\s;&|('"`])(?:remove-item|rm|del)(?=\s|$)/i.test(command)
  }
  return /(?:^|[\s;&|('"`])(?:(?:sudo|command|env)\s+)*(?:(?:\/usr)?\/bin\/)?rm(?=\s|$)/i.test(command)
}

const MCP_CONNECT_COMMAND_MAX_CHARS = 200

/** 答不上来时的统一说法：不编造细节，只说清「可能是本机起进程」，让用户自己决定。 */
const MCP_CONNECT_UNKNOWN_REASON =
  '无法确认这个 MCP 服务的连接方式。若它是 stdio 服务，连接会在你的机器上启动一个子进程。'

/** 查不到 / 说不清时的统一结论：危险，且必须停下来问（Auto 模式也不例外）。 */
function unknownMcpConnectRisk(): ToolRiskAssessment {
  return { level: 'dangerous', reason: MCP_CONNECT_UNKNOWN_REASON, requiresConfirmation: true }
}

function describeMcpLaunch(command: string, consented: boolean): string {
  const shown = command.length > MCP_CONNECT_COMMAND_MAX_CHARS
    ? `${command.slice(0, MCP_CONNECT_COMMAND_MAX_CHARS)}…`
    : command
  const prefix = consented
    ? '连接这个 MCP 服务会在你的机器上启动子进程'
    : '这条启动命令你还没有确认过；连接会在你的机器上首次启动子进程'
  return command ? `${prefix}执行：${shown}` : `${prefix}。`
}

/**
 * 按 serverId 指向的落地方式给「连接 MCP 服务」分级。
 *
 * stdio + 命令行已被用户确认过 → 与执行一条命令同级 → dangerous（确认模式逐次确认，
 *   Auto 模式由用户的明确选择直接执行）。
 * stdio + 命令行【从未被确认过】→ dangerous 且 requiresConfirmation：这条命令没有任何人
 *   看过，Auto 模式也必须停下来先给用户看一眼。Auto 接受的是「模型当场构造的命令」这份
 *   风险，不是「用户以为自己只是存了一份配置」的东西 —— 两者不等价。
 * HTTP  → 只发一次网络请求，不在本机执行任何东西 → safe，不打扰用户。
 * 判不出来（探针没接、id 未登记、探针抛错、参数不是字符串 serverId）→ 按「未确认的 stdio」
 *   处理。这个默认方向是本函数的安全前提：宁可多问一次，也不能因为「查不到」而静默放行
 *   一次进程启动。
 */
function classifyMcpConnectRisk(
  args: unknown,
  probe: McpConnectTargetProbe | undefined,
): ToolRiskAssessment {
  const serverId = stringFromArgs(args, 'serverId').trim()
  if (!serverId || !probe) return unknownMcpConnectRisk()

  let target: McpConnectTarget | undefined
  try {
    target = probe(serverId)
  } catch {
    // 探针是宿主代码，但它崩了不能让风险判定跟着崩，更不能把异常算成「不危险」。
    return unknownMcpConnectRisk()
  }
  if (!target) return unknownMcpConnectRisk()
  if (!target.spawnsLocalProcess) return { level: 'safe' }

  const consented = target.launchConsented === true
  return {
    level: 'dangerous',
    reason: describeMcpLaunch((target.command ?? '').trim(), consented),
    ...(consented ? {} : { requiresConfirmation: true }),
  }
}

// 参数级风险分类。普通变更工具仍是 dangerous；Auto 模式会自动执行它们，
// 但宽范围递归强删、格式化/覆写设备等 critical 操作始终要求人工确认。
export function classifyToolRisk(
  name: string,
  args: unknown,
  context?: ToolRiskContext,
): ToolRiskAssessment {
  // 连接工具没有静态等级：同一个工具、同一份参数形状，指向 stdio 就是本机起进程，
  // 指向 HTTP 就只是一次网络请求。所以它在 isDangerousTool 之前单独分流 ——
  // 它不进 DANGEROUS_TOOLS（那个集合同时决定「可授权给子 agent」，连接能力必须留在父级）。
  if (name === MCP_CONNECT_TOOL_NAME) {
    return classifyMcpConnectRisk(args, context?.mcpConnectTarget)
  }
  if (!isDangerousTool(name)) return { level: 'safe' }
  // MCP 工具来自应用之外，服务端声明与实现也可能在重连后发生变化，
  // 所以仍作为 dangerous：确认模式逐次确认，Auto 模式则由用户的明确选择直接执行。
  if (isMcpTool(name)) {
    return { level: 'dangerous' }
  }
  if (!name.startsWith('shell_')) return { level: 'dangerous' }

  const command = commandFromArgs(args)
  if (
    criticalUnixDelete(command, context?.workspaceRoot)
    || criticalPowerShellDelete(command)
  ) {
    return {
      level: 'critical',
      reason: '检测到可能删除大范围文件的递归强制删除命令；该命令永久删除且无法撤回',
      requiresConfirmation: true,
      irreversible: true,
    }
  }
  if (/\b(?:mkfs(?:\.\w+)?|diskutil\s+erase\w*|format\s+[a-z]:)\b/i.test(command)) {
    return { level: 'critical', reason: '检测到磁盘格式化命令' }
  }
  if (/\bdd\b[^;&\n]*\bof=\/dev\//i.test(command)) {
    return { level: 'critical', reason: '检测到直接覆写设备的命令' }
  }
  if (commandUsesPermanentDelete(name, args)) {
    return {
      level: 'dangerous',
      reason: '命令行 rm 会永久删除文件且无法回退；删除 workspace 文件时应优先使用 delete_path',
      irreversible: true,
    }
  }
  return { level: 'dangerous' }
}
