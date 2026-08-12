// shell 命令行的破坏性写法识别：给定一条命令行，认不认得出它在做「宽范围递归强删」或
// 「永久删除」。
//
// 【为什么与 dangerousTools.ts 分开】那边回答的是【哪些调用要拦、拦到什么级别】——工具集、
// 风险等级、探针注入面与分发；这边只做纯字符串的模式识别，不认识 ToolRisk，也不知道认出来
// 之后会发生什么。两件事挤在一个文件里，一次「多认一种 rm 写法」的改动就会和风险策略的改动
// 混进同一份 diff，而后者是安全门。
//
// 【为什么这里只返回布尔】等级是策略，策略只在 classifyToolRisk 一处。本文件永远不决定
// critical / dangerous，也不决定要不要打断 Auto 模式。

/** shell 工具的命令行参数；不是字符串（含参数结构不对）时按空命令处理。 */
export function commandFromArgs(args: unknown): string {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return ''
  const value = (args as Record<string, unknown>).command
  return typeof value === 'string' ? value : ''
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

export function criticalUnixDelete(command: string, workspaceRoot?: string): boolean {
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

export function criticalPowerShellDelete(command: string): boolean {
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
