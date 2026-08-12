// stdio 服务的「起进程确认」（H2）：一条命令行有没有被用户批准过。
//
// 这个模块只回答一个问题——【现在允许为这个配置真的起连接吗】——并且把答案定义在
// 命令行上，而不是服务上：
//
//   mayLaunchMcpServer(config) === true  ⇔  HTTP（起不了进程），或者 stdio 且它记着的
//                                            确认指纹与当前 command/args/cwd/env 完全一致
//
// 【为什么 env 也算命令行的一部分】（C2a）env 决定这条已确认的命令行【实际执行哪些代码】：
// LD_PRELOAD 往进程里塞一个 .so、PATH 换掉 `npx` 解析到的可执行文件、NODE_OPTIONS 让 node
// 先加载别的模块——三者都不动 command/args 一个字，却把用户当初批准的那件事换掉了。所以改
// env 与改 command/args/cwd 同语义：旧确认作废，重新问一次。
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
 * env ≤ 32 × (128 + 4096)（见 credentialFields.ts）——合计约 200 KB 原文，再乘 JSON 转义
 * 余量。超过这个长度的记录只可能来自被改坏的配置文件，直接丢掉。
 *
 * 【C2a 把它抬高了】env 进指纹之后，一份「填满上限但完全合法」的配置算出来的指纹会超过
 * 原来的 200 000。那样的话每次确认都写下一个读盘时必被丢掉的指纹，用户会陷入「确认了却
 * 永远还要再确认」。上限是防改坏配置的兜底，不该顺手把合法配置也判死。
 */
const MAX_FINGERPRINT_LENGTH = 600_000

/**
 * env 在指纹里的规范形态：按键名排序的 `[键, 值]` 数组；没有 env 或是空表时是 undefined。
 *
 * 【为什么排序】对象的键序取决于写入顺序，而 `{A,B}` 与 `{B,A}` 是同一份环境。不抹平的话，
 * 「编辑界面重排了一下字段」会变成一次莫名其妙的重新确认。这和 args 用数组保住次序是同一条
 * 纪律的两面：有意义的顺序留住，没意义的顺序抹平。比较用 `<`（UTF-16 码元序）而不是
 * `localeCompare`——指纹要在任何机器、任何 locale 下逐字节一致，而 localeCompare 随 ICU 数据变。
 *
 * 【为什么空表等于没有】净化本来就把空 env 收成「字段不存在」（credentialFields.ts 的
 * ABSENT），两者对子进程的影响也完全相同，指纹不该把它们分开。
 */
function normalizeFingerprintEnv(
  env: Readonly<Record<string, string>> | undefined,
): readonly (readonly [string, string])[] | undefined {
  if (!env) return undefined
  const entries = Object.entries(env)
  if (entries.length === 0) return undefined
  return entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
}

/**
 * 命令行的规范化指纹。
 *
 * 用 JSON 元组而不是拼接字符串：参数边界必须是【无歧义】的，否则
 * `cmd "a b"` 与 `cmd a b` 会得到同一个指纹，而它们是两次不同的执行。env 同理用
 * `[键, 值]` 数组而不是 `KEY=VALUE` 拼接：`{A: 'B=1'}` 与 `{'A=B': '1'}` 必须分得开。
 *
 * 【env 只在存在时才占位置】元组固定是 `[command, args, cwd]`，有 env 才追加第四项。这样
 * 【没有 env 的存量配置指纹逐字节不变】，C2a 这次升级不会把老确认集体作废——集体作废意味着
 * 用户要把每个 stdio 服务重新确认一遍，而那些命令行一个字都没改过。同理，同一份 env 删掉
 * 再加回来，指纹会回到原值：确认自动失效、改回来自动恢复这个性质对 env 一样成立。
 */
export function stdioLaunchFingerprint(config: PersistedStdioMcpServer): string {
  const tuple: unknown[] = [config.command, [...config.args], config.cwd ?? null]
  const env = normalizeFingerprintEnv(config.env)
  if (env) tuple.push(env)
  return JSON.stringify(tuple)
}

/**
 * 摆给用户看的那一行命令（不是交给 shell 执行的，所以不做转义）。
 *
 * 【为什么它不含 env / cwd，尽管指纹含】这个字符串还兼着一份跨层身份的差事：模型发起连接
 * 时，tools/mcp 的探针（connect-mcp-server/connectTargetProbe.ts）只拿得到 manager 登记表里的
 * command + args，独立算出同一条字符串；initialize.ts 的 isMcpLaunchConsented 把两侧比对，
 * 确认「用户批准过的那条」就是「将要跑的那条」。往这一侧塞 env，比对会永远不相等，带 env 的
 * 服务每次连接都要重新确认一遍。env 与 cwd 一样，在确认卡片上占【单独一行】
 * （见 stdioLaunchEnvNames 与 ui/McpLaunchConsentPrompt.tsx），该看见的照样看得见。
 */
export function stdioCommandLine(config: PersistedStdioMcpServer): string {
  return [config.command, ...config.args].filter((part) => part.length > 0).join(' ')
}

/**
 * 确认卡片上要点名的环境变量键（按键名排序；没有就是空数组）。
 *
 * 【只给键名，不给值】env 存的就是凭据（credentialFields.ts 的前提），而确认卡片恰恰是最
 * 容易被截屏、录屏、贴进工单的一块界面。用户在这里要判断的是「这条命令会不会被塞进额外的
 * 东西」，键名足以回答——LD_PRELOAD / NODE_OPTIONS / PATH 一眼就认得出——值不必露面。
 */
export function stdioLaunchEnvNames(config: PersistedStdioMcpServer): readonly string[] {
  return normalizeFingerprintEnv(config.env)?.map(([key]) => key) ?? []
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
