// config 域的 registrar：`~/.webAgent/config.json` 与主目录解析
// ---------------------------------------------------------------------------
// 每个域一个 registrar，形状固定：`create<Domain>Routes(options) => NodeHostRouteTable`。
// createNodeHostInvoke.ts 把 16 个域的返回值合成一张总表——所以「这一域负责哪些命令」在这里
// 就说得清，不用翻分发文件。
//
// 本域按 commandNames.ts 负责三条，现已全部落地。域内分层照搬 Rust 侧同一套：
//   configPaths.ts          ← 读写哪个文件（默认路径 / WEB_AGENT_CONFIG_DIR 覆盖 / 旧路径）
//   restrictedWrite.ts      ← 怎么落盘（原子替换 + 目录 0700 / 文件 0600）
//   webAgentConfigStore.ts  ← 一份配置由若干具名段组成（底座，不认任何一段的内容）
//   mcpConfigSection.ts     ← `mcp` 段视图（读整段、按顶层键合并、null 删键）
//   mcpConfigCommands.ts    ← 两条命令的入参收窄
//   userHomeDir.ts          ← get_user_home_dir
//   homeDirectory.ts        ← 主目录解析（上面两处共用的唯一权威）

import { createMcpConfigReadHandler, createMcpConfigWriteHandler } from './mcpConfigCommands'
import { createUserHomeDirHandler } from './userHomeDir'
import type { NodeHostInvokeOptions } from '../hostOptions'
import type { NodeHostRouteTable } from '../routeTable'

export function createConfigRoutes(options: NodeHostInvokeOptions): NodeHostRouteTable {
  return {
    mcp_config_read: createMcpConfigReadHandler(options),
    mcp_config_write: createMcpConfigWriteHandler(options),
    get_user_home_dir: createUserHomeDirHandler(options),
  }
}
