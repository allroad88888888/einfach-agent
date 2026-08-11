// tools/mcp/src/connect-mcp-server/lastKnownTools.ts —— 「上次已知工具清单」的注入契约与分桶。
//
// 【为什么是注入】清单缓存住在 app 层（apps/web/src/mcp/toolNameCache.ts）：它要落磁盘、要和设置
//   面板共用同一份数据。依赖方向是 tools-* ← app，本包不能反向 import 它。切法沿用 F1 的注入式
//   registrar 与 F3 的只读探针：宿主在装配期递进来一个【只读函数】，本域只认这个函数签名，不认
//   它背后是 localStorage、Tauri 配置文件还是测试里的一个常量数组。类型在这里独立声明，与 app
//   的 McpLastKnownTools 结构同形——结构类型让宿主可以直接把 listLastKnownTools(cache) 递进来，
//   而两个包之间没有任何 import 关系。
//
// 【为什么"连没连上"不走探针，而是问 manager】清单是历史，连接状态是此刻的事实，两者权威不同源。
//   已连接服务的工具已经真真切切注册进 ToolRegistry 了，再把它的历史清单抄进工具描述纯属浪费
//   上下文预算，还会诱使模型"再连一次"去拿它其实已经有的东西。所以只对【manager 说没连上】的
//   服务展开历史清单，并且以 manager 的登记表为准做遍历——缓存里残留的、早已被用户删掉的服务
//   不会因此复活。
//
// 【拿不出清单 ≠ 没有工具】探测失败、还没探测过（stdio 待 H2）、探测到空列表，这三种都不能写成
//   "该服务没有工具"。它们进 gaps 桶，由呈现层说成"暂无已知清单"——模型据此仍可以决定连上去看看，
//   而不是被一句伪造的"没有工具"劝退。

/** 与 app 侧 McpToolProbeStatus 同形。 */
export type McpLastKnownProbeStatus = 'success' | 'failed'

export interface McpLastKnownToolEntry {
  readonly name: string
  readonly description: string
}

/** 一个服务【上次已知】的工具清单；与 app 侧 McpLastKnownTools（B4 读出口）结构同形。 */
export interface McpLastKnownToolList {
  readonly serverId: string
  readonly tools: readonly McpLastKnownToolEntry[]
  /** 上次探测到的工具总数；tools 被缓存侧上限截断时它仍是真实总数。 */
  readonly toolCount: number
  /** tools 是否已被缓存侧上限截断。 */
  readonly truncated: boolean
  /** 这份清单被探测到的时刻（epoch 毫秒）。取清单必然连带取到它，见 B4 的类型说明。 */
  readonly cachedAt: number
  readonly probeStatus: McpLastKnownProbeStatus
}

/** 宿主注入的只读读出口。不接这根线时工具描述里不会出现任何清单（绝不编造）。 */
export type McpLastKnownToolsProbe = () => readonly McpLastKnownToolList[]

/** 遍历登记表只需要这两个字段；用结构类型而不是 McpServerSnapshot，测试里造替身更省事。 */
export interface McpConfiguredServerState {
  readonly id: string
  readonly status: string
}

export type McpLastKnownGapReason = 'never_probed' | 'probe_failed' | 'no_tools'

export interface McpLastKnownGap {
  readonly serverId: string
  readonly reason: McpLastKnownGapReason
}

/** 呈现层的唯一输入：能展开的清单 + 拿不出清单的服务。两个桶都只含【未连接】服务。 */
export interface McpLastKnownDigest {
  readonly listed: readonly McpLastKnownToolList[]
  readonly gaps: readonly McpLastKnownGap[]
}

/** Date 能表示的绝对毫秒上限；超出会让 toISOString() 抛 RangeError。 */
const MAX_SAFE_EPOCH_MS = 8.64e15

function isUsableTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_SAFE_EPOCH_MS
}

function sanitizeEntry(raw: unknown): McpLastKnownToolEntry | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const { name, description } = raw as { name?: unknown; description?: unknown }
  if (typeof name !== 'string' || !name.trim()) return undefined
  return { name, description: typeof description === 'string' ? description : '' }
}

function indexByServerId(
  entries: readonly McpLastKnownToolList[],
): Map<string, McpLastKnownToolList> {
  const byId = new Map<string, McpLastKnownToolList>()
  for (const entry of entries) {
    if (entry && typeof entry.serverId === 'string' && entry.serverId) {
      byId.set(entry.serverId, entry)
    }
  }
  return byId
}

function classify(
  server: McpConfiguredServerState,
  entry: McpLastKnownToolList | undefined,
): McpLastKnownToolList | McpLastKnownGap {
  if (!entry || !isUsableTimestamp(entry.cachedAt)) {
    return { serverId: server.id, reason: 'never_probed' }
  }
  if (entry.probeStatus !== 'success') {
    return { serverId: server.id, reason: 'probe_failed' }
  }
  const tools = (Array.isArray(entry.tools) ? entry.tools : [])
    .map(sanitizeEntry)
    .filter((tool): tool is McpLastKnownToolEntry => tool !== undefined)
  if (tools.length === 0) {
    return { serverId: server.id, reason: 'no_tools' }
  }
  // toolCount 取"宿主给的总数"与"实际条数"的较大值：宿主的 toolCount 才是探测到的真实总数
  // （缓存侧截断过），但它若因故小于实际条数，用它去算"还有几个没列出来"会得到负数。
  const declared = typeof entry.toolCount === 'number' && Number.isFinite(entry.toolCount)
    ? Math.floor(entry.toolCount)
    : tools.length
  const toolCount = Math.max(declared, tools.length)
  return {
    serverId: server.id,
    tools,
    toolCount,
    truncated: entry.truncated === true || toolCount > tools.length,
    cachedAt: entry.cachedAt,
    probeStatus: 'success',
  }
}

function isGap(value: McpLastKnownToolList | McpLastKnownGap): value is McpLastKnownGap {
  return 'reason' in value
}

/**
 * 把「宿主的历史清单」和「manager 的当前登记表」合成一份呈现层输入。
 *
 * 探针没接线（或调用即抛）→ 返回 undefined，呈现层据此一个字都不写：宁可让模型少看到一段提示，
 * 也不能让一个坏掉的宿主接线把manifest 变成半真半假的清单。同理，manager.list() 抛错也走这条路。
 *
 * 遍历顺序跟随 manager 的登记表（= 用户的配置顺序），因此同一份配置每次生成的文案完全一致，
 * 不会因为缓存写入顺序变化而让 manifest 抖动。
 */
export function collectLastKnownDigest(
  probe: McpLastKnownToolsProbe | undefined,
  listServers: () => readonly McpConfiguredServerState[],
): McpLastKnownDigest | undefined {
  if (typeof probe !== 'function') return undefined

  let entries: readonly McpLastKnownToolList[]
  let servers: readonly McpConfiguredServerState[]
  try {
    entries = probe() ?? []
    servers = listServers() ?? []
    if (!Array.isArray(entries) || !Array.isArray(servers)) return undefined
  } catch {
    return undefined
  }

  const byId = indexByServerId(entries)
  const listed: McpLastKnownToolList[] = []
  const gaps: McpLastKnownGap[] = []
  for (const server of servers) {
    if (!server || typeof server.id !== 'string' || !server.id) continue
    if (server.status === 'connected') continue
    const classified = classify(server, byId.get(server.id))
    if (isGap(classified)) gaps.push(classified)
    else listed.push(classified)
  }
  return { listed, gaps }
}
