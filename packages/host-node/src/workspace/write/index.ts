// workspace/write 域的 registrar：`write_workspace_file`
// ---------------------------------------------------------------------------
// 每个域一个 registrar，形状固定：`create<Domain>Routes(options) => NodeHostRouteTable`
// （样板见 src/config/index.ts）。本域只有一条命令，但它是全仓库唯一「会改用户文件」的通用
// 写入口，所以实现按 Rust 侧同一套分工摊成十来个文件：
//
//   limits.ts / limitChecks.ts        ← _limits.rs + normalize_max_bytes（W5）
//   targetPath.ts                     ← _target_path.rs（W5）
//   lockTable.ts / lockArchive*.ts    ← _lock.rs（W6）
//   options.ts                        ← _options.rs 的 parse_mode / parse_encoding
//   before.ts                         ← _before.rs
//   guard.ts                          ← _guard.rs
//   fsOps.ts                          ← _fs_ops.rs
//   base64.ts                         ← _base64.rs（W8，严格 RFC 4648 解码）
//   （changeSummary 现住 `../common`）  ← workspace_common.rs 的 compute_change_summary / diff_lines
//   result.ts                         ← _result.rs
//   pipelinePayload / Plan / Write /
//     pipeline.ts                     ← _pipeline.rs（锁外编排 / 锁内临界区 / 纯判断 / 载荷）
//   compaction*.ts                    ← _compaction.rs（W9，纯规则与 IO 分住两个文件）
//   writeWorkspaceFileHandler.ts      ← workspace_write.rs 的命令体

import { createWriteWorkspaceFileHandler } from './writeWorkspaceFileHandler'
import type { NodeHostInvokeOptions } from '../../hostOptions'
import type { NodeHostRouteTable } from '../../routeTable'

export function createWriteRoutes(options: NodeHostInvokeOptions): NodeHostRouteTable {
  return {
    write_workspace_file: createWriteWorkspaceFileHandler(options),
  }
}
