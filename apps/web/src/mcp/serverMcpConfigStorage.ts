// server 宿主的 MCP 配置存储：经 `POST /api/invoke/mcp_config_{read,write}` 读写
// `~/.webAgent/config.json` 的 `mcp.servers`。
// ---------------------------------------------------------------------------
// `tauriMcpConfigStorage.ts` 的同接口替身，**段语义一字不改**：读到的 servers 键缺席才触发
// 一次性迁移、空数组以配置文件为准、格式非法一律报错绝不覆盖。三条判据的理由写在那份文件里，
// 这里不重复——重复一遍就是给同一条规则立第二个权威。
//
// 【真正的差别只有一处：传输】`invoke('mcp_config_read')` → `invokeServerCommand(...)`。
// 命令名、参数名（`patch`）、返回形状完全相同：host-node 的 `config/mcpConfigCommands.ts`
// 是桌面宿主 `mcp_config.rs` 的等价移植（原件已随 T1／提交 `e52c31d` 删除，只能从 Git 历史读），
// 连「这两条命令没有 `rename_all`、所以
// `patch` 两种口径下同名」都逐条核对过（见那个文件的文件头）。
//
// 【为什么净化与限额仍在前端】`sanitizeConfigs` 是白名单 + 上限 + 去重，跑在**写之前**，
// 所以一份超限的配置连命令都发不出去。这与桌面端一致；服务端不该反过来依赖它，
// 但也没有理由让浏览器把明知非法的东西发出去。
//
// 【迁移这条线在 server 宿主上同样成立】`createLegacyMcpServerMigration` 搬的是
// localStorage 里的存量（浏览器宿主本来就用那把键），而 server 宿主的用户**就是**从
// 「pnpm dev / 静态产物」那条路走过来的那批人——他们的存量正好在 localStorage 里。
// 迁移只复制、不清空，理由见 `legacyServerMigration.ts`。

import { createLegacyMcpServerMigration } from './legacyServerMigration'
import { sanitizeConfigs, type McpConfigStorage } from './persistence'
import type { PersistedMcpServerConfig } from './types'
import { invokeServerCommand } from '../host/serverInvoke'

/** 与 `tauriMcpConfigStorage.ts` 的同名常量一致：`mcp` 段里存服务清单的那个键。 */
const MCP_CONFIG_SERVERS_KEY = 'servers'

function describeError(prefix: string, error: unknown): Error {
  if (error instanceof Error && error.message.trim()) {
    return new Error(`${prefix}：${error.message}`)
  }
  if (typeof error === 'string' && error.trim()) {
    return new Error(`${prefix}：${error}`)
  }
  return new Error(prefix)
}

/**
 * 取出 mcp 段里的 servers 列表。三种情况分开，判据与 `tauriMcpConfigStorage.ts` 逐字相同：
 *
 * - `undefined`：键根本不存在（含整段缺失/形状不对）——迁移唯一的触发条件。
 * - 数组：以配置文件为准，哪怕是空数组（用户可能刚删掉最后一个服务）。
 * - 抛错：键存在但格式非法——报出来，绝不用迁移覆盖它。
 */
function extractServers(section: unknown): readonly unknown[] | undefined {
  if (typeof section !== 'object' || section === null || Array.isArray(section)) {
    return undefined
  }
  const servers = (section as Record<string, unknown>)[MCP_CONFIG_SERVERS_KEY]
  if (servers === undefined) return undefined
  if (!Array.isArray(servers)) {
    throw new Error('mcp 配置段中的 servers 字段格式无效')
  }
  return servers
}

async function writeServers(configs: readonly PersistedMcpServerConfig[]): Promise<void> {
  const safeConfigs = sanitizeConfigs(configs)
  try {
    await invokeServerCommand<unknown>('mcp_config_write', {
      patch: { [MCP_CONFIG_SERVERS_KEY]: safeConfigs },
    })
  } catch (error) {
    throw describeError('无法保存 MCP 配置', error)
  }
}

/**
 * 经本机 Node 服务读写 MCP 服务清单。
 *
 * 假定 server 宿主确实在（装配层已经用 `resolveHost()` 判过），本文件不再自己探一次——
 * 探测只有一处权威，多一处只会在两处结论不同时静默走岔。
 */
export function createServerMcpConfigStorage(): McpConfigStorage {
  // 迁移复用同一条写通道（净化、错误话术都只有一处），与桌面版同构。
  const migrateLegacyServers = createLegacyMcpServerMigration(writeServers)
  return {
    persistence: 'persistent',
    async load() {
      let section: unknown
      try {
        // 无参命令。`args` 是必填形参（可为 `undefined`）：显式传它，比让类型推断替我们
        // 决定要好——`mcp_config_read` 在 host-node 那边「`args` 里有什么都不看」。
        section = await invokeServerCommand<unknown>('mcp_config_read', undefined)
      } catch (error) {
        throw describeError('无法读取 MCP 配置', error)
      }
      const servers = extractServers(section)
      // 配置文件里还没有 servers 键 → 把 localStorage 存量搬进来的唯一时机。
      if (servers === undefined) return migrateLegacyServers()
      return sanitizeConfigs(servers)
    },
    save: writeServers,
  }
}
