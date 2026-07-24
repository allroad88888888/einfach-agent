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

// 简介：MCP 工具由外部服务动态提供，第一期统一按逐次确认处理。
export function isMcpTool(name: string): boolean {
  return name.startsWith('mcp__')
}

// 简介：某工具名是否属于「执行前需用户确认」的危险工具集。
export function isDangerousTool(name: string): boolean {
  return DANGEROUS_TOOLS.has(name) || isMcpTool(name)
}

// 简介：只有内建危险工具可被显式授权给子 agent；MCP 工具必须留在父级逐次确认边界。
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

function commandFromArgs(args: unknown): string {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return ''
  const command = (args as Record<string, unknown>).command
  return typeof command === 'string' ? command : ''
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

// 参数级风险分类。普通变更工具仍是 dangerous；Auto 模式会自动执行它们，
// 但宽范围递归强删、格式化/覆写设备等 critical 操作始终要求人工确认。
export function classifyToolRisk(
  name: string,
  args: unknown,
  context?: { workspaceRoot?: string },
): ToolRiskAssessment {
  if (!isDangerousTool(name)) return { level: 'safe' }
  // MCP 工具来自应用之外，服务端声明与实现也可能在重连后发生变化。
  // 在 registry 能提供可审计的来源/只读元数据前，第一期统一要求逐次确认，
  // 包括 Auto 模式，避免把第三方 tool description 当作安全边界。
  if (isMcpTool(name)) {
    return {
      level: 'dangerous',
      reason: '该操作由外部 MCP 服务执行，调用前需要确认将发送的参数',
      requiresConfirmation: true,
    }
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
