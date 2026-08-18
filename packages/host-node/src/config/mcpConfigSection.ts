// `config.json` 的 `mcp` 段视图：读整段、按顶层键合并补丁
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/mcp_config.rs 的 `McpConfigStore`。Rust 侧的分层在 Node 侧原样保留：
// webAgentConfigStore.ts 是**底座**（认「一份配置由若干具名段组成」），本文件是它的**一个段视图**
// （认 `mcp` 段里放的是 MCP 服务清单与工具名缓存）。命令名叫 mcp_config_*，读写的却是那份共用的
// `~/.webAgent/config.json`——两层分开正是为了让这件事说得清：底座换段名就能给别的域复用，
// 而段视图永远只看得见自己那一段。
//
// **凭证边界落在这一层的段名上**：`modelCredentials` 与 `mcp` 是两个平级的段，本文件请求的段名
// 恒为 `mcp`，所以前端经这两条命令拿不到、也写不到模型 Key——不是靠某处过滤，是压根没请求。

import type { WebAgentConfigStore } from './webAgentConfigStore'

const MCP_SECTION = 'mcp'

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 读整个 `mcp` 段；配置文件或该段不存在时返回空对象。
 *
 * 段存在但不是对象时**原样返回**（不强行整形成 `{}`）：对齐 Rust 的 `read()`，也让
 * 「配置里 mcp 段被写坏了」在调用方那里仍看得出来。前端 extractServers 本来就判形状。
 */
export async function readMcpSection(store: WebAgentConfigStore): Promise<unknown> {
  const section = await store.readSection(MCP_SECTION)
  return section === undefined ? {} : section
}

/**
 * 把 `patch` 的**顶层键**合并进现有 `mcp` 段，返回合并后的整段。
 *
 * 语义逐条对齐 Rust：
 *   · **浅合并**——按顶层键整值替换，不深合并。`{"servers": [...]}` 换掉整个 servers 数组，
 *     但同段里的 `toolNameCache` 原样保留。（深合并会让「删掉清单里的最后一台服务」变成不可能
 *     表达：空数组和"没提到"在深合并下无法区分。）
 *   · `null` = **删键**，不是写入 null。
 *   · 补丁不是 JSON 对象时受控失败，不当成空补丁。
 *   · 读—改—写整体在 store 的锁内完成，其余顶层段（含 `modelCredentials`）不受影响。
 */
export async function mergeMcpSection(
  store: WebAgentConfigStore,
  patch: unknown,
): Promise<unknown> {
  if (!isJsonObject(patch)) throw new Error('mcp 配置段补丁必须是 JSON 对象')
  await store.updateSection(MCP_SECTION, (current) => {
    if (current !== undefined && !isJsonObject(current)) {
      throw new Error('mcp 配置段格式无效')
    }
    const section = new Map(Object.entries(current ?? {}))
    for (const [key, value] of Object.entries(patch)) {
      // 值为 undefined 的键当作没写。进程内注入时它到得了这里，走 HTTP 时 JSON.stringify 会把它
      // 整个丢掉——不跳过就成了「本地删得掉、上 server 删不掉」的那类不一致。要删键请传 null。
      if (value === undefined) continue
      if (value === null) section.delete(key)
      else section.set(key, value)
    }
    // 恒为对象（哪怕空）：Rust 那边也只写不删，`mcp` 段一旦出现就不会再消失。
    return Object.fromEntries(section)
  })
  // 与 Rust 一致：合并后重新读一次再返回，回给调用方的是**落盘之后**的事实。
  return readMcpSection(store)
}
