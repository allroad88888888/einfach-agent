// `mcp_config_read` / `mcp_config_write` 的 Node 实现
// ---------------------------------------------------------------------------
// 这一层只做两件事：把装配槽 + 进程环境解析成本次要读写的路径，以及**收窄外部入参**。
// 段语义在 mcpConfigSection.ts，文件读写在 webAgentConfigStore.ts。
//
// 入参名核对（Rust: apps/desktop/src/mcp_config.rs（已随 T1 删除））：
//   · `mcp_config_read(app)` —— 除 AppHandle 外无参，调用点是 `invoke('mcp_config_read')`。
//   · `mcp_config_write(app, patch: Value)` —— 一个参数 `patch`。这两条命令**没有**
//     `rename_all = "snake_case"`，走 Tauri 默认的 camelCase→snake_case 转换；`patch` 是单个
//     小写单词，两种口径下同名，所以 Node 侧照收 `patch`。前端调用点
//     （apps/web/src/mcp/tauriMcpConfigStorage.ts、toolNameCacheStorage.ts）传的也是 `patch`。

import { resolveConfigPathsFromOptions } from './configPaths'
import { mergeMcpSection, readMcpSection } from './mcpConfigSection'
import { createWebAgentConfigStore, type WebAgentConfigStore } from './webAgentConfigStore'
import type { NodeHostInvokeOptions } from '../hostOptions'
import type { NodeHostCommandHandler } from '../routeTable'

async function openStore(options: NodeHostInvokeOptions): Promise<WebAgentConfigStore> {
  return createWebAgentConfigStore(await resolveConfigPathsFromOptions(options))
}

/** 读整个 `mcp` 段。无参——`args` 里有什么都不看，多传的键不构成另一种行为。 */
export function createMcpConfigReadHandler(
  options: NodeHostInvokeOptions,
): NodeHostCommandHandler {
  return async () => readMcpSection(await openStore(options))
}

/**
 * 把 `patch` 合并进 `mcp` 段并返回合并后的整段。
 *
 * `patch` 缺席与 `patch` 不是对象分开报：前者是调用方漏传参数（Tauri 那边由 command 的
 * 反序列化挡住，Node 这条路上没有那一层，必须自己判），后者是补丁本身不合法。
 * 判缺席只看值、不用 `'patch' in args`：core 的 `toTauriInput` 整份对象字面量返回，可选项无值时
 * 键存在且为 undefined，走 HTTP 时 `JSON.stringify` 又会把它丢掉——用 `in` 会写出「进程内能跑、
 * 上 server 就变」的分歧。
 */
export function createMcpConfigWriteHandler(
  options: NodeHostInvokeOptions,
): NodeHostCommandHandler {
  return async (args) => {
    if (args.patch === undefined) throw new Error('mcp_config_write 缺少 patch 参数')
    return mergeMcpSection(await openStore(options), args.patch)
  }
}
