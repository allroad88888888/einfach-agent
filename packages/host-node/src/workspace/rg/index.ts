// workspace/rg 域的 registrar：`rg_search_workspace`
// ---------------------------------------------------------------------------
// 样板同 src/config/index.ts。本域只有一条命令，按内容检索（依赖外部 `rg` 可执行文件），
// 与 workspace/read 域按**文件名**匹配的 `search_workspace_files` 是两回事。域内分层：
//   constants.ts             ← 六个常量（DEFAULT/MAX matches、context lines、stderr 上限、
//                               --max-filesize），逐字照搬 Rust
//   types.ts                 ← RgSearchResult / RgSearchMatch 输出形状 + failedRgResult
//   normalizeRgInput.ts       ← query / contextLines / maxMatches / regex / caseSensitive 收窄
//   normalizeGlobs.ts         ← globs 校验（相对、无 NUL、无 `..`）
//   normalizeRgTargetPath.ts  ← path 参数解析成传给 rg 的目标字符串（复用 workspace/common 的
//                               confinement，而不是像 Rust 那样自己再抄一份）
//   spawnRg.ts                ← 拼参数 + spawn 子进程，rg 缺失时给可读错误
//   parseRgStdout.ts          ← `--json` 逐行事件解析（本域主体逻辑，纯到可以喂假 JSON 行测）
//   rgSearchWorkspaceHandler.ts ← 编排以上各步，对齐 Rust 的 `rg_search_workspace_blocking`

import { createRgSearchWorkspaceHandler } from './rgSearchWorkspaceHandler'
import type { NodeHostInvokeOptions } from '../../hostOptions'
import type { NodeHostRouteTable } from '../../routeTable'

export function createRgRoutes(options: NodeHostInvokeOptions): NodeHostRouteTable {
  return {
    rg_search_workspace: createRgSearchWorkspaceHandler(options),
  }
}
