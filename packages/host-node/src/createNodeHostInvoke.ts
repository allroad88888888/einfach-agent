// Node 宿主的命令路由表：一份能力实现，三种传输
// ---------------------------------------------------------------------------
// 这里返回的 `HostInvoke` 就是 core 的 `configureHostInvoke(loader)` 要收的那个东西
// （packages/agent-core/src/runtime/hostBridge.ts）。H 线已经把 core 里 13 个 runtime 模块的
// 宿主判据从「是不是 Tauri」换成了「有没有登记命令桥」，所以这张表一旦装上，core 那些文件/
// shell/git 能力在**任何**能跑 Node 的地方都成立，不再依赖桌面 webview。
//
//                     ┌─ 浏览器 ────── HTTP ─────┐
//   core（TS，不变）──▶├─ CLI ───────── 进程内 ────┼──▶ 本包 ──▶ 系统调用
//     configureHostInvoke└─ Tauri 套壳 ── sidecar ──┘   （一份能力实现）
//
// 三种传输共用**同一张表**：apps/server（S 线）把它挂在 `POST /api/invoke/:command` 后面，
// CLI 直接进程内注入（N8），未来的 Tauri 套壳起 sidecar 用的还是它。所以这张表里不许出现任何
// HTTP——外壳是 apps/server 的事，本包只认「命令名 + 一袋参数 → 一个结果」。
//
// ═══ 这张表将来怎么按域拆 ═══
// 域的划分与 commandNames.ts 的 `NODE_HOST_COMMANDS_BY_DOMAIN` **逐键对应**，键名就是目录名：
//
//   src/
//     createNodeHostInvoke.ts   ← 本文件：只做「合表 + 分发 + 明确失败」
//     commandNames.ts           ← 28 条命令全集与分域（唯一权威）
//     commandArgs.ts            ← 每条命令的入参形状
//     commandPayloads.ts        ← 入参里被多条命令共用的嵌套载荷
//     hostOptions.ts            ← 装配槽（各域按需往里加）
//     routeTable.ts             ← 域 registrar 的返回类型
//     workspace/
//       common/                 ← 无命令：路径禁闭 + 变更日志，被下面各域共用
//       read/                   ← read_workspace_file / read_workspace_run_index_page /
//                                  list_workspace_files / search_workspace_files
//       write/                  ← write_workspace_file
//       patch/                  ← apply_workspace_patch
//       change/                 ← revert_workspace_change
//       delete/                 ← delete_workspace_path
//       pathOps/                ← copy_workspace_path / move_workspace_path
//       git/                    ← get_workspace_diff
//       rg/                     ← rg_search_workspace
//       task/                   ← run_workspace_task
//     shell/                    ← run_shell_command
//     mcp/                      ← mcp_connect / mcp_list_tools / mcp_call_tool / mcp_disconnect
//     model/                    ← model_provider_request / cancel_model_provider_request /
//                                  model_chat_completions / cancel_model_chat_completions /
//                                  model_credential_status / _set / _delete
//     config/                   ← mcp_config_read / mcp_config_write / get_user_home_dir  ✅本卡
//     events/                   ← 无命令：模型流式响应的 Channel、MCP stdio 生命周期 emit/listen
//                                  在 Node 侧的替身。`(cmd, args) => Promise<T>` 装不下反向通道，
//                                  所以它是独立设计，不是某条命令的实现细节。
//     sqlite/                   ← 无命令（当前）：桌面侧走 @tauri-apps/plugin-sql，不在本仓库的
//                                  `#[tauri::command]` 列表里。Node 侧定下命令名后要回 commandNames.ts 登记。
//
// 每个域交出一个 registrar：`create<Domain>Routes(options) => NodeHostRouteTable`
// （样板见 src/config/index.ts）。落地一域 = 建目录 + 写 registrar + 在下面 createRoutes 里加
// 一行展开。**不要**在本文件里直接写 handler：28 条命令摊进来必然顶破 300 行，而且每加一条
// 都要动这个所有域共用的文件。
//
// 目录本卡没有预先建空壳——git 不跟踪空目录，占位文件只是噪音。上面这棵树就是规格。

import type { HostInvoke } from '@web-agent/core'
import { isNodeHostCommandName } from './commandNames'
import { createConfigRoutes } from './config'
import { createShellRoutes } from './shell'
import { createChangeRoutes } from './workspace/change'
import { createDeleteRoutes } from './workspace/delete'
import { createMcpRoutes } from './mcp'
import { createModelRoutes } from './model'
import { createGitRoutes } from './workspace/git'
import { createPatchRoutes } from './workspace/patch'
import { createPathOpsRoutes } from './workspace/pathOps'
import { createReadRoutes } from './workspace/read'
import { createRgRoutes } from './workspace/rg'
import { createTaskRoutes } from './workspace/task'
import { createWriteRoutes } from './workspace/write'
import type { NodeHostInvokeOptions } from './hostOptions'
import type { NodeHostRouteTable } from './routeTable'

/**
 * 命令分发失败的原因。两者对调用方的含义**完全不同**，所以不能塌成一种：
 *   · `unimplemented` —— 名字合法，只是对应的域还没落地。调用方等后续卡即可，代码本身没错。
 *   · `unknown-command` —— 名字不在 28 条全集里。拼错了、用了废弃名，或 Rust 侧新增了命令而
 *     commandNames.ts 没跟上。这种永远等不到，必须改代码。
 *
 * S 线把它映射成 HTTP 状态码时按 `reason` 分：`unimplemented` → 501，`unknown-command` → 404。
 * 判别用 `reason` 字段而不是 `instanceof`——错误要跨 HTTP 边界序列化，那一头拿到的是 JSON。
 */
export type NodeHostCommandErrorReason = 'unimplemented' | 'unknown-command'

/**
 * 分发层的明确失败。
 *
 * 为什么不能静默返回 undefined：`HostInvoke` 的调用点全都写成
 * `const raw = await invoke<unknown>(...)` 后面接一段 `normalizeResult(raw)`，而那些
 * normalize 函数对付不认识的形状一律给兜底值（空内容、`ok: false`、空列表），**不抛错**。
 * 所以一个 undefined 会被安静地整形成「一次成功但什么都没读到的读取」，病因埋在十几层调用
 * 之下，症状是模型看到空文件、用户看到功能没反应。N 线有 24 张卡的窗口期，这段时间里每一条
 * 未实现的命令都必须在第一现场喊出来。
 */
export class NodeHostCommandError extends Error {
  override readonly name = 'NodeHostCommandError'
  readonly command: string
  readonly reason: NodeHostCommandErrorReason

  constructor(command: string, reason: NodeHostCommandErrorReason) {
    super(
      reason === 'unimplemented'
        ? `Node 宿主尚未实现命令「${command}」：它已登记在命令全集里，但本次装配的路由表没有它的实现。`
        : `Node 宿主收到未登记的命令「${command}」：它不在命令全集内。若这是宿主新增的命令，先把它登记进 commandNames.ts 再实现。`,
    )
    this.command = command
    this.reason = reason
  }
}

/**
 * 合成总表。落地一个域就在这里加一行展开——顺序无所谓（域之间键不相交，由
 * `NODE_HOST_COMMANDS_BY_DOMAIN` 保证），但按 commandNames.ts 的域顺序排，两边好对照。
 */
function createRoutes(options: NodeHostInvokeOptions): NodeHostRouteTable {
  return {
    // model 域只挂两条 cancel——转发本身是流式，不走 `(cmd,args)=>Promise<T>`，由 M2 的 SSE
    // 端点直接调 forwardProviderRequest（见 model/index.ts）。28 条命令至此全部落地。
    ...createReadRoutes(options),
    ...createWriteRoutes(options),
    ...createPatchRoutes(options),
    ...createChangeRoutes(options),
    ...createDeleteRoutes(options),
    ...createPathOpsRoutes(options),
    ...createGitRoutes(options),
    ...createRgRoutes(options),
    ...createTaskRoutes(options),
    ...createShellRoutes(options),
    ...createMcpRoutes(options),
    ...createModelRoutes(options),
    ...createConfigRoutes(options),
  }
}

/**
 * 建一个按 command 名分发的 `HostInvoke`，交给 `configureHostInvoke` 用。
 *
 * 参数可选：`createNodeHostInvoke()` 与 `createNodeHostInvoke({})` 等价，都表示全取默认。
 * 装配槽见 hostOptions.ts。
 *
 * **表在 create 时就定死**（不是每次调用现查现搭）：装配槽被闭包捕获，之后同一个 invoke 的
 * 行为不会随外部状态改变。要换宿主配置就重新 create 一个并重新 `configureHostInvoke`——
 * core 那边本来就把「重新登记 loader」当作作废旧桥的信号。
 */
export function createNodeHostInvoke(options: NodeHostInvokeOptions = {}): HostInvoke {
  const routes = createRoutes(options)

  // 必须写成 async 函数：失败一律是 **rejection，不是同步抛出**。理由与 core 的 loadHostInvoke
  // 逐字相同——调用点里既有 `await invoke(...)`（在 try 里，同步抛也接得住），也有
  // `void invoke(...).catch(...)` 这种不在 async 函数里的写法（apps/web 的模型传输层就是），
  // 同步异常会绕过它的 catch 链变成未捕获错误。统一成 rejection，两种写法都接得住。
  const invoke: HostInvoke = async <T>(
    command: string,
    args?: Record<string, unknown>,
  ): Promise<T> => {
    // 先判名字再查表：直接查表时「没实现」和「名字不存在」会塌成同一个 `undefined`。
    if (!isNodeHostCommandName(command)) {
      throw new NodeHostCommandError(command, 'unknown-command')
    }
    const handler = routes[command]
    if (!handler) throw new NodeHostCommandError(command, 'unimplemented')
    // `args` 缺省补 `{}`：调用点里确实有不传第二个实参的（`invoke('get_user_home_dir')`），
    // 让每个 handler 各写一遍空值判断只会漏。
    // 断言到 T 是这个签名固有的：类型实参只是调用点的编译期承诺，运行时形状由 core 侧紧跟着
    // 的 normalizeResult 认——本层不假装校验过。
    return (await handler(args ?? {})) as T
  }

  return invoke
}
