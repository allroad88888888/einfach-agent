// config 域的 registrar：`~/.webAgent/config.json` 与主目录解析
// ---------------------------------------------------------------------------
// 每个域一个 registrar，形状固定：`create<Domain>Routes(options) => NodeHostRouteTable`。
// createNodeHostInvoke.ts 把 16 个域的返回值合成一张总表——所以「这一域负责哪些命令」在这里
// 就说得清，不用翻分发文件。
//
// 本域按 commandNames.ts 负责三条：`mcp_config_read` / `mcp_config_write` / `get_user_home_dir`，
// 本卡只落地最后一条，前两条留给后续卡。**没实现的命令这里就不要写键**：写一个恒抛错的占位
// handler 会让分发层把它认成「已实现但坏了」，正是本卡要避免的那种语义不明的失败。

import type { NodeHostInvokeOptions } from '../hostOptions'
import type { NodeHostRouteTable } from '../routeTable'
import { createUserHomeDirHandler } from './userHomeDir'

export function createConfigRoutes(options: NodeHostInvokeOptions): NodeHostRouteTable {
  return {
    get_user_home_dir: createUserHomeDirHandler(options),
    // 待落地：mcp_config_read / mcp_config_write（`~/.webAgent/config.json` 的 `mcp` 段读写，
    // 写是 patch 合并语义、`null` 表示删键，不是整段覆盖——见 commandArgs.ts）。
  }
}
