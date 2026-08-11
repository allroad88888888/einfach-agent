// stdio 服务的「起进程确认」（H2）：一条命令行有没有被用户批准过。
//
// 这个模块只回答一个问题——【现在允许为这个配置真的起连接吗】——并且把答案定义在
// 命令行上，而不是服务上：
//
//   mayLaunchMcpServer(config) === true  ⇔  HTTP（起不了进程），或者 stdio 且它记着的
//                                            确认指纹与当前 command/args/cwd 完全一致
//
// 【为什么是指纹而不是一个 approved 布尔】用户确认的是「在我的机器上执行
// `npx -y @some/mcp`」这件事，服务名和 id 只是标签。如果只记一个布尔，将来加了配置
// 编辑界面（F6 的实现者明确警告过这条路），把 command 改成别的东西之后旧确认照样成立，
// 下次冷启动就会无人过问地执行新命令。指纹让「改了命令 = 确认作废」成为数据模型自带的
// 性质，而不是一条要求将来每个编辑路径都记得执行的约定。手改 config.json 同理。
//
// 【判定只有这一处】sanitize 只检查确认记录的形状，不顺手比对指纹；比对固定发生在
// mayLaunchMcpServer 里。两处各判一次早晚会漂移，而这是一道安全门。

import type {
  McpStdioLaunchConsent,
  PersistedMcpServerConfig,
  PersistedStdioMcpServer,
} from './types'

/**
 * 指纹上限：command ≤ 512、参数 ≤ 64 × 1024、cwd ≤ 1024（见 config.ts 的校验），
 * 加上 JSON 转义余量。超过这个长度的记录只可能来自被改坏的配置文件，直接丢掉。
 */
const MAX_FINGERPRINT_LENGTH = 200_000

/**
 * 命令行的规范化指纹。
 *
 * 用 JSON 元组而不是拼接字符串：参数边界必须是【无歧义】的，否则
 * `cmd "a b"` 与 `cmd a b` 会得到同一个指纹，而它们是两次不同的执行。
 */
export function stdioLaunchFingerprint(config: PersistedStdioMcpServer): string {
  return JSON.stringify([config.command, [...config.args], config.cwd ?? null])
}

/** 摆给用户看的那一行命令（不是交给 shell 执行的，所以不做转义）。 */
export function stdioCommandLine(config: PersistedStdioMcpServer): string {
  return [config.command, ...config.args].filter((part) => part.length > 0).join(' ')
}

/**
 * 现在允许为这个配置建立真实连接吗。
 *
 * HTTP 恒为 true：它只发网络请求，不在本机起进程，风险分级见 F3 的
 * tools/mcp/src/connect-mcp-server/connectTargetProbe.ts。
 */
export function mayLaunchMcpServer(config: PersistedMcpServerConfig): boolean {
  if (config.transport !== 'stdio') return true
  const consent = config.launchConsent
  if (!consent) return false
  return consent.fingerprint === stdioLaunchFingerprint(config)
}

/** 把「用户确认过当前这条命令行」写进配置。 */
export function grantStdioLaunchConsent(
  config: PersistedStdioMcpServer,
  approvedAt: number,
): PersistedStdioMcpServer {
  return {
    ...config,
    launchConsent: { fingerprint: stdioLaunchFingerprint(config), approvedAt },
  }
}

/** 读盘时的形状校验：只放行 { fingerprint: string, approvedAt: number }。 */
export function sanitizeStdioLaunchConsent(
  value: unknown,
): McpStdioLaunchConsent | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  const fingerprint = input.fingerprint
  const approvedAt = input.approvedAt
  if (typeof fingerprint !== 'string') return undefined
  if (!fingerprint || fingerprint.length > MAX_FINGERPRINT_LENGTH) return undefined
  if (typeof approvedAt !== 'number' || !Number.isFinite(approvedAt) || approvedAt < 0) {
    return undefined
  }
  return { fingerprint, approvedAt }
}
