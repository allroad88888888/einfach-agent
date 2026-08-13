// tools/mcp/src/placeholderResult.ts —— 透明连接路径上【占位独有】的两条回执，加上所有占位
// 回执都要打的那个标记。
//
// 【与 connect-mcp-server/connectFailureResult.ts 的分工】连接抛错与连接超时的翻译在那边，
// 本文件一个字都不重复（占位直接调它那两个函数，retryable 仍由分类器决定）。这里只放那边
// 没有、也不该有的两件事：
//   · 占位对应的服务已经不在登记表里了（显式连接工具连的是模型自己点名的服务，它遇不到
//     「替一个已经消失的服务执行一次调用」这种局面）；
//   · 服务连上了，但真实清单里没有这个工具（那是「上次已知」缓存与远端现状不一致的结局，
//     只有占位这条路才会撞上）。
//
// 【为什么不写进 placeholderExecute.ts】那边是编排（先做什么后做什么、哪一步能被取消），
// 本文件是翻译（一个结局用什么措辞、什么 code、可不可重试）。两者分开，措辞才有一个能单独
// 断言的单元——这和 connectFailureResult.ts 从 connect-mcp-server.ts 里拆出来是同一条理由。

import type { ToolResult } from '@web-agent/core/tools'
import { describeConnectedServer } from './connect-mcp-server/connectedServerResult'
import { isRecord, truncate } from './internal'
import type { McpServerSnapshot } from './types'

/** 服务连上之后真实清单里没有这个工具时的判别码。 */
export const MCP_TOOL_NOT_IN_SERVER_CODE = 'MCP_TOOL_NOT_IN_SERVER'

/**
 * 给一条占位自己产出的失败回执打上「这是一次透明连接」的标记。
 *
 * 连接失败的文案与 connect_mcp_server 完全共用，两条路径于是在 trace 里长得一模一样，
 * 这个标记是唯一的分辨点（蓝图第六节：让 trace 能把两类失败分开统计）。
 *
 * 【只标占位自己的回执】委派成功、或真实 adapter 自己产出的失败（MCP_REMOTE_ERROR 等）
 * 一律原样返回：那已经是一次普通的 MCP 调用结果，占位没有资格改写它。
 */
export function markViaPlaceholder(result: ToolResult): ToolResult {
  if (!('ok' in result) || result.ok) return result
  // details 在本域一律是 record（上面两个 builder 与 connectFailureResult.ts 都是），
  // 不是 record 时宁可不合并也不丢掉它——把外部数据塞进对象展开是另一类风险。
  const details = isRecord(result.details) ? result.details : undefined
  return {
    ...result,
    details: details ? { ...details, viaPlaceholder: true } : { viaPlaceholder: true },
  }
}

/**
 * 占位对应的服务已不在 manager 的登记表里（被用户删了，或从未登记）。
 *
 * 不可重试，且【绝不回显任何连接目标】：这条路上没有可以连的东西，回执里也就不该出现
 * url / 命令行之类的东西。serverId 是应用本地的键，来自我们自己的缓存而不是模型的输入，
 * 留在 details 里供 trace 对账。
 */
export function buildPlaceholderServerGoneResult(
  serverId: string,
  toolName: string,
): ToolResult {
  return {
    ok: false,
    error: `工具 ${truncate(toolName, 80)} 所属的 MCP 服务已不在已配置服务列表里，无法连接，也无法执行`,
    code: 'MCP_SERVER_NOT_CONFIGURED',
    retryable: false,
    hint: '这个工具名来自【上次已知】的缓存清单，而它所属的服务已被删除或从未被登记：'
      + '没有可以先连接的目标，原样重试也不会有任何变化。请改用其它工具，'
      + '或让用户在设置里重新添加该服务。',
    details: { serverId },
  }
}

/**
 * 服务已连接，但真实清单里没有这个名字（远端改名或下线了，缓存还留着旧条目）。
 *
 * 回执附【当前真实清单】——这些工具此刻已经注册进 ToolRegistry，本 run 内就能点名加载与
 * 执行（工具集 epoch 的「成员只增不减」），所以这条回执是可自愈的：模型照着清单换一个工具
 * 即可，不需要再连一次。
 */
export function buildPlaceholderToolGoneResult(
  toolName: string,
  snapshot: McpServerSnapshot,
  alreadyConnected: boolean,
): ToolResult {
  return {
    ok: false,
    error: `MCP 服务「${truncate(snapshot.id, 80)}」已连接，但它的真实工具清单里没有 ${truncate(toolName, 80)}`,
    code: MCP_TOOL_NOT_IN_SERVER_CODE,
    retryable: false,
    hint: '这个名字来自【上次已知】的缓存清单，工具可能已经改名或下线。服务已经连上了，'
      + '此刻一律以真实清单为准：原样重试无意义。请从 details.tools 里挑一个仍然存在的工具，'
      + '先读它的 schema 再调用。',
    details: {
      ...describeConnectedServer(snapshot, alreadyConnected),
      requestedTool: toolName,
    },
  }
}

/**
 * 委派回来的失败里【没有 code】的那一类：那是 registry.run 自己的守卫产出的，绝大多数是
 * 「参数没通过真实工具 inputSchema 的校验」。
 *
 * 判据成立的理由：真实 MCP adapter 的失败一律带 code（MCP_INVALID_ARGUMENTS /
 * MCP_REMOTE_ERROR / MCP_TOOL_TIMEOUT / MCP_TRANSPORT_ERROR），所以这条判据不会误伤远端错误；
 * 反过来，registry.run 的校验失败只有一个 error 字符串，模型光看它并不知道「schema 已经变了」。
 *
 * 补的这句与 tool_schema_autoloaded 的措辞同源：这次的参数是照着【占位的透传 schema】猜的，
 * 而真实 schema 随连接成功后的新注册版本自动进下一轮请求的 tools 字段——按它重试即可，
 * 不要沿用本次猜测的参数。
 */
export function annotateDelegatedFailure(result: ToolResult, toolName: string): ToolResult {
  if (!('ok' in result) || result.ok || result.code !== undefined) return result
  return markViaPlaceholder({
    ...result,
    hint: `${truncate(toolName, 80)} 所属的 MCP 服务已经连上，这次失败出在委派给真实工具那一步——`
      + '最常见的原因是本次参数没有通过真实 schema 的校验（占位的 schema 只保证「参数是一个对象」，'
      + '不代表远端接受哪些字段）。真实 schema 随下一轮请求的 tools 一起下发并此后长期保留；'
      + '请按它重新发起调用，不要沿用本次猜测的参数。',
  })
}
