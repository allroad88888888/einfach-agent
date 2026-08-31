// workspace/read 域的 registrar —— 五条读命令的落地点。
//
// **`read_workspace_file` 唯一该注册的是 `linesDispatch.ts` 的 `createReadWorkspaceFileHandler`。**
// 这个域有两个签名相同、名字只差两个词的工厂：
//   · createReadWorkspaceFileHandler       ← linesDispatch，先按入参分派行模式/字节模式（正确）
//   · createReadWorkspaceFileBytesHandler  ← bytesRead，只会字节模式
// 挂错成后者不会报错、测试也照样绿，症状是**模型传 `startLine` 却拿到从头 20 KB 的字节片**——
// 行参数被静默忽略。W2 交回时专门点名了这个坑，这里再记一次，因为它只在接线这一步可能犯。
//
// 分派判据本身在 linesDispatch 里：`start_line` 与 `line_count` 两个都没给才走字节模式；
// 进了行模式后 `offset` **大于 0** 才算冲突（`offset: 0` 不算传了）。

import type { NodeHostInvokeOptions } from '../../hostOptions'
import type { NodeHostRouteTable } from '../../routeTable'
import { createReadWorkspaceFileHandler } from './linesDispatch'
import { createListWorkspaceFilesHandler } from './listFiles'
import { createReadWorkspaceRunIndexPageHandler } from './runIndexRead'
import { createSearchWorkspaceFilesHandler } from './searchFiles'
import { createReadWorkspaceImageHandler } from '../workspace-image-read'

export function createReadRoutes(options: NodeHostInvokeOptions): NodeHostRouteTable {
  return {
    read_workspace_file: createReadWorkspaceFileHandler(options),
    read_workspace_image: createReadWorkspaceImageHandler(options),
    read_workspace_run_index_page: createReadWorkspaceRunIndexPageHandler(options),
    list_workspace_files: createListWorkspaceFilesHandler(options),
    search_workspace_files: createSearchWorkspaceFilesHandler(options),
  }
}
