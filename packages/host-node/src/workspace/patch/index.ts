// workspace/patch 域的 registrar：`apply_workspace_patch`
// ---------------------------------------------------------------------------
// 每个域一个 registrar，形状固定：`create<Domain>Routes(options) => NodeHostRouteTable`
// （样板见 src/config/index.ts）。本域只有一条命令，但它是全表最大的一条——四种操作、乐观守卫、
// 限额、路径禁闭、变更日志、原子落盘与回滚全在里面，所以域内按 Rust 侧同一套分层摊开
// （左边一列是 apps/desktop/src/（已随 T1 删除）里的对应文件）：
//
//   types.ts                       ← 跨文件共享的形状（W12 定的接口面）
//   operation.ts                   ← _operation.rs：入参收窄成四个变体
//   limits.ts                      ← _limits.rs：文本大小与二进制上限
//   guard.ts                       ← _guard.rs：oldContent / expectedContentHash 乐观守卫
//   path.ts                        ← _path.rs：目标路径解析与 workspace 禁闭
//   stageRules.ts / stage.ts       ← _stage.rs：纯规则那半边 / 带 IO 那半边
//   fs.ts                          ← _fs.rs：读旧文本、原子写、执行位、删
//   commit.ts                      ← _commit.rs：落盘与中途失败的逆序还原
//   （changeSummary 现住 `../common`） ← workspace_common.rs 的 compute_change_summary / diff_lines
//   result.ts                      ← _result.rs：回执形状
//   pipeline.ts                    ← _pipeline.rs：主流程编排
//   applyWorkspacePatchHandler.ts  ← workspace_patch.rs 的命令体
//
// 纯逻辑与 IO 分住不同文件（`stageRules` / `limits` / `guard` 及 `../common` 的 `lineDiff` /
// `changeSummary` 一行 IO 都没有），是为了 W16 的跨语言对拍能不建临时目录树就喂 fixture——patch
// 引擎是点名要对拍的两块之一。
//
// 本域**不占任何装配槽**：workspace root 每次调用自己给，变更日志目录由 `defaultJournalDirectory`
// 从 `options` 推。参数照收 `NodeHostInvokeOptions` 是为了让所有域的 registrar 长同一个样子。

import { createApplyWorkspacePatchHandler } from './applyWorkspacePatchHandler'
import type { NodeHostInvokeOptions } from '../../hostOptions'
import type { NodeHostRouteTable } from '../../routeTable'

export function createPatchRoutes(options: NodeHostInvokeOptions): NodeHostRouteTable {
  return {
    apply_workspace_patch: createApplyWorkspacePatchHandler(options),
  }
}
