// F7 判据：哪些工具【永远】不能被记进本会话的「一律允许」—— 单点，三个调用点都问这里。
// ---------------------------------------------------------------------------
// alwaysAllowedTools 是【按工具名】记忆的：勾一次「一律允许」，本会话内此后所有同名调用都
// 直接放行，不再看参数。所以凡是【风险由参数决定】的工具都没有资格进这份记忆 —— 否则用户
// 对一次无害调用的同意，会被自动放大成对同名危险调用的同意。
//
// 当前两类，都从这一处出，不在别处再写一遍名字匹配：
//   · `mcp__` 前缀工具 —— 实现在外部服务里，重连后同名工具可能换一套行为（前缀判定的唯一
//     出处仍是 dangerousTools.isMcpTool，这里只是引用它）。
//   · connect_mcp_server —— 同一个工具名，serverId 指向 HTTP 就只是一次网络请求，指向 stdio
//     就是在用户本机拉起子进程（见 dangerousTools.classifyToolRisk）。对 A 服务点一次「一律
//     允许」若能记住工具名，本会话内连接【任意】已配置服务都不再确认。
//
// 本判据只回答「这个工具名有没有资格被记住」。「这一次确认要不要真的记下来」还要叠加
// critical / irreversible / 注册版本是否仍然当前等运行时条件，那些留在命令层
// （runtime/commands/runCommands.ts 的 confirmTool）。
//
// 三个调用点各守一层，缺一不可：
//   · confirmTool —— 决定这次「允许 + 一律」要不要落库；
//   · addAlwaysAllowedTool（writer）—— 拒绝写入，挡住绕过命令层的直接调用；
//   · isToolAlwaysAllowed（reader）—— 即使 atom 已被污染（历史数据、测试、越权写入）也永不
//     认账，这是最后一道闸。

import { isMcpTool, MCP_CONNECT_TOOL_NAME } from './dangerousTools'

/**
 * 永不进入 session 记忆的具体工具名。
 *
 * 【完整工具名等值匹配】，不是前缀特判：前缀会把任何以它开头的名字一并卷进来，等值只认这
 * 一个。新增「风险由参数决定」的内建工具时在这里补一行。
 */
export const NEVER_REMEMBERED_TOOLS: ReadonlySet<string> = new Set([MCP_CONNECT_TOOL_NAME])

/** 该工具名是否有资格被记进本会话的「一律允许」集合。 */
export function canRememberToolApproval(toolName: string): boolean {
  return !isMcpTool(toolName) && !NEVER_REMEMBERED_TOOLS.has(toolName)
}
