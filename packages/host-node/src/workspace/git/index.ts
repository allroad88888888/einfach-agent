// workspace/git 域的 registrar：`get_workspace_diff`
// ---------------------------------------------------------------------------
// 每个域一个 registrar，形状固定：`create<Domain>Routes(options) => NodeHostRouteTable`
// （样板见 src/config/index.ts）。域内分层照搬 Rust 侧同一套：
//   diffRequest.ts    ← 入参收窄（桌面端由 Tauri 的 command 反序列化代劳，这条路上没有那一层）
//   gitArgs.ts        ← argv 构造与参数归一化（**参数白名单**：flag 全是字面量）
//   gitPathspecs.ts   ← pathspec 的 workspace 内 confine
//   gitExec.ts        ← 加固后的 git 子进程（env 三件套 + 带上限的流式读）
//   workspaceDiff.ts  ← 主流程：status / stat / diff 三次调用与结果汇总
//   unicodeWhitespace.ts ← 上面两处共用的 Rust `trim` / `is_control` 等价物
//
// 本域**不占任何装配槽**：workspace root 由每次调用自己给（或由 git 仓库根兜底），不是宿主
// 启动时定死的一份配置。参数照收 `NodeHostInvokeOptions` 只是为了让所有域的 registrar 长同一
// 个样子——`createRoutes` 里那一行展开不必为某一域写特例。

import { narrowWorkspaceDiffArgs } from './diffRequest'
import { getWorkspaceDiff } from './workspaceDiff'
import type { NodeHostInvokeOptions } from '../../hostOptions'
import type { NodeHostRouteTable } from '../../routeTable'

export function createGitRoutes(_options: NodeHostInvokeOptions): NodeHostRouteTable {
  return {
    get_workspace_diff: async (args) => getWorkspaceDiff(narrowWorkspaceDiffArgs(args)),
  }
}
