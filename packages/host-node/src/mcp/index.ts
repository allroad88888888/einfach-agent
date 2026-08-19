// mcp 域的 registrar：MCP server 的 stdio 传输
// ---------------------------------------------------------------------------
// 本域按 commandNames.ts 负责四条：mcp_connect / mcp_list_tools / mcp_call_tool / mcp_disconnect。
// 等价移植 apps/desktop/src/mcp*.rs（已随 T1 删除；除 mcp_config.rs，那是 `~/.webAgent/config.json` 里 `mcp`
// 段的读写，已在 config 域）。域内分层照搬 Rust 侧同一套：
//
//   limits.ts        ← 协议版本、超时、各种上限（唯一权威，与 Rust 逐值相同）
//   errors.ts        ← McpCommandError：kind 是契约，message 不是
//   validation.ts    ← 入参归一化（trim / 长度 / 协议版本 / 超时）
//   argNarrowing.ts  ← `Record<string, unknown>` → 具体类型的原子操作
//   inputs.ts        ← 四条命令的入参形状与收窄
//   results.ts       ← 四条命令的返回形状与对端载荷收窄
//   frames.ts        ← **行帧切分**：粘包 / 半包 / 超大行（本域最容易写错的一处）
//   dispatch.ts      ← 一条 JSON-RPC 消息该往哪去
//   pending.ts       ← 在途请求表        writer.ts ← 往 stdin 写一行
//   reader.ts        ← stdout → 帧 → 分发 → EOF 报关闭
//   childProcess.ts  ← spawn / 整组强杀 / stderr 排空
//   exitNet.ts       ← 宿主进程退出时的兜底清理
//   session.ts       ← 一条会话的状态机（请求、传输关闭、收尾）
//   sessionSpawn.ts  ← 起进程 + 接三条管道      initialize.ts ← 握手
//   toolOperations.ts← tools/list 翻页 / tools/call
//   manager.ts       ← 会话登记表与世代检查
//
// ═══ 本域的边界：传输，不是协议编排 ═══
// `tools/mcp`（5178 行 TS）已经有的东西这里**一个字都不重写**：工具适配与 schema 校验、
// 集合对账、命名冲突、退避重连、保活探活、占位工具、工具清单缓存、失败分类、起进程确认。
// 这里只有「把 JSON-RPC 帧搬进搬出一个子进程」以及**四条命令契约自带的**那部分协议——
// initialize 握手（`mcp_connect` 的返回值就是它）与 tools/list 分页（`mcp_list_tools` 的返回值
// 就是它）。这两段在 TS 侧**没有第二份可复用**：全仓 grep 过，`tools/mcp` 里没有任何 stdio 的
// JSON-RPC 实现，Streamable HTTP 那条路的握手在官方 SDK 里。所以本域是把唯一那一份从 Rust
// 挪过来，不是造第二份。
//
// ═══ 装配层要接的两个口（本卡不接线，形状定在这里）═══
//
// ① **事件出口（C2）**：`emitHostEvent`。子进程侧会主动冒出两件事——对端说"工具变了"、
//    连接掉了。它们不是任何一条命令的返回值，`(cmd, args) => Promise<T>` 装不下。
//    详细规格与载荷见 lifecycle.ts 的文件头。不传 = 事件丢弃，连接照常可用。
//
// ② **关停钩子**：`registerHostDisposer`。桌面端靠 Tauri 释放 managed state 触发 `Drop` 来关
//    全部会话，Node 没有析构。本域自带一道 `process.on('exit')` 兜底（exitNet.ts），它覆盖正常
//    退出与 `process.exit()`，**但覆盖不到 SIGTERM / SIGINT**（已实测：Node 对无 listener 的
//    信号走默认处置，'exit' 回调根本不执行）。信号处理必须由宿主装配层做——只有它知道自己是
//    CLI 还是 server，也只有它知道 Ctrl-C 在自己这里是"中断本轮"还是"退出"。把 dispose 挂进去
//    是一行的事，不挂则退化到只有那道兜底。

import { discardHostEvents, type McpHostEventEmitter } from './lifecycle'
import {
  narrowCallToolInput,
  narrowConnectInput,
  narrowDisconnectInput,
  narrowListToolsInput,
} from './inputs'
import { McpSessionManager } from './manager'
import type { NodeHostInvokeOptions } from '../hostOptions'
import type { NodeHostRouteTable } from '../routeTable'

/**
 * 本域自己的装配槽。**有意不加进 hostOptions.ts**：那是所有域共用的文件，而 M 线 / C 线 /
 * P 线正在并行落地各自的域，同时改它必冲突。两个槽都是可选的，所以一个普通的
 * `NodeHostInvokeOptions` 原样传进来即可编译——接线时不必先动共用文件。
 */
export interface McpRoutesOptions extends NodeHostInvokeOptions {
  /** 生命周期事件出口（C2）。不传 = 丢弃。规格见 lifecycle.ts。 */
  emitHostEvent?: McpHostEventEmitter
  /** 关停钩子。装配层拿到 dispose 后挂进自己的信号处理。不传 = 只剩 exitNet 那道兜底。 */
  registerHostDisposer?: (dispose: () => Promise<void>) => void
}

export function createMcpRoutes(options: McpRoutesOptions = {}): NodeHostRouteTable {
  // 管理器**随路由表一起创建、被闭包捕获**：会话登记表必须与这张表同寿命。做成模块级单例的话，
  // 两次 `createNodeHostInvoke` 会共用一张登记表，测试之间互相看得见对方的会话；
  // 做成每次调用现建的话，第二条命令就找不到第一条建立的会话了。
  const manager = new McpSessionManager(options.emitHostEvent ?? discardHostEvents)
  options.registerHostDisposer?.(() => manager.disposeAll())

  // 四个 handler 都写成 `async`：入参收窄是**同步**抛出的，而路由表的契约是「失败一律是
  // rejection」。少一个 async，一份形状不对的载荷会变成同步异常，绕过调用点的 `.catch` 链
  // 变成未捕获错误（apps/web 的传输层确实有 `void invoke(...).catch(...)` 这种写法）。
  return {
    mcp_connect: async (args) => manager.connect(narrowConnectInput(args)),
    mcp_list_tools: async (args) => manager.listTools(narrowListToolsInput(args)),
    mcp_call_tool: async (args) => manager.callTool(narrowCallToolInput(args)),
    mcp_disconnect: async (args) => manager.disconnect(narrowDisconnectInput(args)),
  }
}

export type { McpHostEvent, McpHostEventEmitter, McpHostEventName } from './lifecycle'
