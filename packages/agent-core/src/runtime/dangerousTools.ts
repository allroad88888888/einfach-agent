// S4-B 危险工具集判定 —— 哪些 server 工具在执行前需要用户确认。
// ---------------------------------------------------------------------------
// 「危险」= 任意本机执行或直接变更磁盘的 server 工具：本机 shell（macos/linux/powershell）、
// 写文件、打补丁。只读工具不在内 —— 不需确认。
//
// run_task 有执行项目脚本的风险，但它不是任意 shell：只接受固定 kind，后端固定 argv、workspace、
// timeout 和输出上限。这里刻意不纳入确认集，保留「改代码 → 跑验证」的最小闭环。
// 单点定义，供 modelRun tool 循环在「分发工具前」判定是否暂停等确认（镜像 ask_user 暂停）。

import {
  commandFromArgs,
  commandUsesPermanentDelete,
  criticalPowerShellDelete,
  criticalUnixDelete,
} from './shellCommandRisk'

// 根 agent 的内建危险工具全集。MCP 另由动态前缀判定，不能进入子 agent 能力集合。
const DANGEROUS_TOOL_NAMES = [
  'shell_macos',
  'shell_linux',
  'shell_powershell',
  'write_file',
  'apply_patch',
  'delete_path',
  'copy_path',
  'move_path',
  'revert_workspace_change',
] as const

export type DangerousTool = (typeof DANGEROUS_TOOL_NAMES)[number]

// 根级危险策略的 owner；未来 root-only 工具只加到 DANGEROUS_TOOL_NAMES，绝不自动可委派。
export const DANGEROUS_TOOLS: ReadonlySet<string> = new Set(DANGEROUS_TOOL_NAMES)

// 可授权给子 agent 的内建危险工具子集。MCP 工具始终停留在父级执行边界。
export const DELEGATABLE_DANGEROUS_TOOLS = [
  'shell_macos',
  'shell_linux',
  'shell_powershell',
  'write_file',
  'apply_patch',
  'delete_path',
  'copy_path',
  'move_path',
  'revert_workspace_change',
] as const satisfies readonly DangerousTool[]

export type DelegatableDangerousTool = (typeof DELEGATABLE_DANGEROUS_TOOLS)[number]

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
export function isDelegatableDangerousTool(name: string): name is DelegatableDangerousTool {
  return (DELEGATABLE_DANGEROUS_TOOLS as readonly string[]).includes(name)
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

/**
 * 【注册名】→ 这一次 `mcp__*` 调用会不会先在本机拉起进程，由装配 MCP 占位工具的宿主注入。
 *
 * 【为什么与 mcpConnectTarget 是两根线】问的不是一件事：那根按 serverId 回答「连接这个服务
 *   会落到哪里」，这根按注册名回答「模型现在要调的这一个工具，执行之前会不会先起一次进程」。
 *   后者的事实要由宿主合成（这个名字现在是不是某个未连接服务的占位、那个服务的启动命令行
 *   用户确认过没有），core 既够不着占位登记表，也够不着确认记录。
 *
 * 【返回 undefined 的默认方向与 mcpConnectTarget 相反 —— 不从严】这里的 undefined 读作
 *   「这次调用不会拉起任何进程」（服务已连接、这名字不是占位、宿主没接这根线），一律维持
 *   `mcp__*` 的既有 dangerous。反过来从严的话，已连接服务的每一次普通 MCP 调用都会在 Auto
 *   模式下停下来问一遍，那是回归。
 *
 *   安全性因此不靠这里的默认方向兜底，而靠装配侧一条硬约束：**占位工具的注册与本探针必须
 *   在同一处接线、同进同退**（apps/web/src/mcp/toolProbeWiring.ts）。没有占位就没有透明连接，
 *   也就不存在可被静默拉起的进程；接了占位就必然接了这根线。
 */
export type McpToolLaunchTargetProbe = (toolName: string) => McpConnectTarget | undefined

/** classifyToolRisk 的注入面：core 拿不到的运行时事实统统从这里进来。 */
export interface ToolRiskContext {
  workspaceRoot?: string
  mcpConnectTarget?: McpConnectTargetProbe
  mcpToolLaunchTarget?: McpToolLaunchTargetProbe
}

/** 连接工具的 serverId 参数；不是字符串（例如模型直接塞了一整份连接配置）时按空处理。 */
function serverIdFromArgs(args: unknown): string {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return ''
  const value = (args as Record<string, unknown>).serverId
  return typeof value === 'string' ? value.trim() : ''
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
  const serverId = serverIdFromArgs(args)
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

/**
 * 卡片上要先说清「这次调用不只是一次调用」，再摆出那条命令行。
 *
 * 用户看到的是一个 `mcp__<服务>__<工具>`，从名字上看不出它会先在本机起一个进程 ——
 * 那是透明连接的代价，必须在确认卡片上补回来。
 */
const MCP_TOOL_LAUNCH_PREFIX = '该 MCP 服务尚未连接，本次工具调用会先自动连接它。'

/**
 * 给一次 `mcp__*` 调用分级。
 *
 * 已连接的服务 / HTTP 服务 / 宿主没接线 → 维持既有的 dangerous：确认模式逐次确认，
 *   Auto 模式由用户的明确选择直接执行（零回归，见 McpToolLaunchTargetProbe 的默认方向）。
 * 未连接 + stdio + 命令行已确认 → dangerous，与今天执行一条命令同级（Auto 放行），
 *   但仍带上 reason：确认模式下用户要看得到这次调用会先跑哪条命令。
 * 未连接 + stdio + 命令行【从未被确认过】→ dangerous 且 requiresConfirmation：Auto 模式
 *   也必须停下来。判据与 connect_mcp_server 完全同源——同一条命令行、同一份确认记录，
 *   只是这次由一个 mcp__* 调用触发；由模型换一条路径触发不该换一套准入。
 */
function classifyMcpToolCallRisk(
  name: string,
  probe: McpToolLaunchTargetProbe | undefined,
): ToolRiskAssessment {
  if (!probe) return { level: 'dangerous' }

  let target: McpConnectTarget | undefined
  try {
    target = probe(name)
  } catch {
    // 探针是宿主代码，崩了不能让风险判定跟着崩。这里【不】升级为必须确认：探针答不上来时
    // 从严会让已连接服务的普通调用在 Auto 下集体停摆，而这条路径的安全性由「占位与探针
    // 同处接线」保证（见 McpToolLaunchTargetProbe）。
    return { level: 'dangerous' }
  }
  if (!target?.spawnsLocalProcess) return { level: 'dangerous' }

  const consented = target.launchConsented === true
  return {
    level: 'dangerous',
    reason: `${MCP_TOOL_LAUNCH_PREFIX}${describeMcpLaunch((target.command ?? '').trim(), consented)}`,
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
  // 它不进可委派子集：连接能力必须留在父级，root 风险则由本参数级分流决定。
  if (name === MCP_CONNECT_TOOL_NAME) {
    return classifyMcpConnectRisk(args, context?.mcpConnectTarget)
  }
  if (!isDangerousTool(name)) return { level: 'safe' }
  // MCP 工具来自应用之外，服务端声明与实现也可能在重连后发生变化，所以底线仍是 dangerous：
  // 确认模式逐次确认，Auto 模式则由用户的明确选择直接执行。在此之上还有一层——透明连接让
  // 一次普通调用可能顺带在本机拉起进程，那一层由下面这个探针的事实决定（D3a）。
  if (isMcpTool(name)) {
    return classifyMcpToolCallRisk(name, context?.mcpToolLaunchTarget)
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
