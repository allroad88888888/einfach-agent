// 未连接服务的工具名清单缓存：数据契约——写入的清洗与上限、读出的「上次已知」语义。
// 读写通道见同目录的 toolNameCacheStorage.ts——本文件不碰磁盘，只负责"什么形状的数据是安全的"。
//
// 【过期语义 · B4】MCP 协议本来就有 tools/list_changed，工具集会变；三个月前探测到的清单
// 今天可能已经不对。所以这份数据对外【只能】被当作「上次已知」读取，连上服务之后一律以
// 服务返回的真实清单为准。落法见文件下半段 McpLastKnownTools：读出口把 tools 与 cachedAt
// 焊在同一个对象里，消费方拿不到"没有时间戳的工具清单"，也就没机会把它当成当前事实。
//
// 模型在决定要不要 connect_mcp_server 之前，需要知道一个未连接服务大致有哪些工具。
// 只存名字与短描述，绝不存 inputSchema——那属于 request_tool_schema 那一层，且要求
// 工具已注册（= 已连接），缓存 schema 会诱使模型直接调用未连接的工具，破坏惰性加载
// 的分层（见 tools/mcp/src/toolAdapter.ts 的 MCP_INPUT_SCHEMA_MAX_CHARS 说明）。
//
// 这份数据最终会整体进模型上下文（见 F4），因此必须有硬上限；三条上限的取值和处理
// 策略见下方常量旁的注释。

export type McpToolProbeStatus = 'success' | 'failed'

export interface McpToolNameCacheEntry {
  readonly name: string
  readonly description: string
}

export interface McpToolNameCacheRecord {
  readonly tools: readonly McpToolNameCacheEntry[]
  /** 探测到的工具总数，即使 tools 因上限被截断也保留原始数量。 */
  readonly toolCount: number
  readonly cachedAt: number
  readonly probeStatus: McpToolProbeStatus
}

/** 按 serverId 组织的整份缓存。 */
export type McpToolNameCache = Readonly<Record<string, McpToolNameCacheRecord>>

/**
 * 单个服务缓存的工具条数上限。真实 MCP 服务的工具数通常在几十以内；200 已能覆盖
 * 绝大多数工具网关型服务，继续增长通常意味着探测异常或服务在滥用工具枚举——
 * 超出部分直接丢弃（截断），因为这些多出来的条目对「要不要连这个服务」的决策
 * 边际价值很低，却会线性摊薄下面的总长度预算。
 */
export const MCP_TOOL_NAME_CACHE_MAX_TOOLS_PER_SERVER = 200

/**
 * 单条工具描述的字符上限。这里只需要模型判断「值不值得连」，不是完整工具说明书
 * （完整描述是 tools/mcp/toolAdapter.ts 里 512 字符的 MCP_DESCRIPTION_MAX_CHARS，
 * 且只在工具真正注册后才存在）。超出部分截断并加省略号，而不是丢弃整条——
 * 一句话摘要即使被截断，通常仍能看出工具大致是做什么的。
 */
export const MCP_TOOL_NAME_CACHE_DESCRIPTION_MAX_CHARS = 160

/**
 * 单条工具名的字符上限。真实工具名很短，这里只是防御性上限，避免单个异常长的
 * 名字绕开上面的描述上限去吃总长度预算。
 */
export const MCP_TOOL_NAME_CACHE_NAME_MAX_CHARS = 200

/**
 * 整份缓存（所有 server 合计）序列化后的字符上限。这份数据会整体进模型上下文，
 * 服务数量上限是 50（见 persistence.ts 的 MCP_SETTINGS_MAX_SERVERS），单靠单服务
 * 上限乘起来仍可能失控。超限时只截断"正在写入的那一条"，绝不因为一次写入而
 * 收缩其它服务已缓存的数据——这样每次写入的影响范围可预测、易测试。截断从
 * 该条目的工具列表尾部开始逐个丢弃，直至整体符合预算或该条目工具清零为止；
 * toolCount 仍保留探测到的真实总数，不随截断改变。
 */
export const MCP_TOOL_NAME_CACHE_TOTAL_MAX_CHARS = 20_000

export interface McpToolNameCacheProbedTool {
  readonly name: string
  readonly description?: string
}

export interface SetToolNameCacheEntryInput {
  readonly tools: readonly McpToolNameCacheProbedTool[]
  readonly probeStatus: McpToolProbeStatus
  /** 默认 Date.now()；显式传入主要是为了让测试可确定。 */
  readonly cachedAt?: number
}

/** 供 toolNameCacheStorage.ts 复用，判断存储读回的原始 JSON 是否是普通对象。 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isProbeStatus(value: unknown): value is McpToolProbeStatus {
  return value === 'success' || value === 'failed'
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  if (maxChars <= 1) return value.slice(0, Math.max(0, maxChars))
  return `${value.slice(0, maxChars - 1)}…`
}

function sanitizeToolEntry(raw: unknown): McpToolNameCacheEntry | undefined {
  if (!isPlainRecord(raw)) return undefined
  const { name } = raw
  if (typeof name !== 'string' || !name.trim()) return undefined
  const description = typeof raw.description === 'string' ? raw.description : ''
  return {
    name: truncateText(name, MCP_TOOL_NAME_CACHE_NAME_MAX_CHARS),
    description: truncateText(description, MCP_TOOL_NAME_CACHE_DESCRIPTION_MAX_CHARS),
  }
}

function estimateChars(value: unknown): number {
  return JSON.stringify(value)?.length ?? 0
}

/** 从条目尾部逐个丢弃工具，直到整份缓存（其余条目 + 这一条）符合总长度预算。 */
function fitRecordToBudget(
  rest: McpToolNameCache,
  serverId: string,
  record: McpToolNameCacheRecord,
): McpToolNameCacheRecord {
  let tools = record.tools
  let candidateRecord = record
  while (
    tools.length > 0
    && estimateChars({ ...rest, [serverId]: candidateRecord }) > MCP_TOOL_NAME_CACHE_TOTAL_MAX_CHARS
  ) {
    tools = tools.slice(0, -1)
    candidateRecord = { ...record, tools }
  }
  return candidateRecord
}

function insertRecordWithBudget(
  cache: McpToolNameCache,
  serverId: string,
  record: McpToolNameCacheRecord,
): McpToolNameCache {
  const rest: McpToolNameCache = Object.fromEntries(
    Object.entries(cache).filter(([id]) => id !== serverId),
  )
  const fitted = fitRecordToBudget(rest, serverId, record)
  return { ...rest, [serverId]: fitted }
}

function sanitizeStoredRecord(raw: unknown): McpToolNameCacheRecord | undefined {
  if (!isPlainRecord(raw)) return undefined
  if (!isProbeStatus(raw.probeStatus)) return undefined
  if (typeof raw.cachedAt !== 'number' || !Number.isFinite(raw.cachedAt)) return undefined
  const rawTools = Array.isArray(raw.tools) ? raw.tools : []
  const tools = rawTools
    .map(sanitizeToolEntry)
    .filter((entry): entry is McpToolNameCacheEntry => entry !== undefined)
    .slice(0, MCP_TOOL_NAME_CACHE_MAX_TOOLS_PER_SERVER)
  const toolCount =
    typeof raw.toolCount === 'number' && Number.isFinite(raw.toolCount) && raw.toolCount >= 0
      ? Math.floor(raw.toolCount)
      : tools.length
  return { tools, toolCount, cachedAt: raw.cachedAt, probeStatus: raw.probeStatus }
}

/**
 * 把可能损坏、越权或超预算的原始数据降级为一份安全的缓存。用于所有存储后端的
 * load() 路径：单条数据格式不对就整条丢弃，不因为一个坏条目让整份缓存读取失败——
 * 这只是缓存，丢了顶多触发重新探测，不该阻断应用启动。
 */
export function sanitizeToolNameCache(raw: unknown): McpToolNameCache {
  if (!isPlainRecord(raw)) return {}
  let cache: McpToolNameCache = {}
  for (const [serverId, rawRecord] of Object.entries(raw)) {
    if (!serverId) continue
    const record = sanitizeStoredRecord(rawRecord)
    if (!record) continue
    cache = insertRecordWithBudget(cache, serverId, record)
  }
  return cache
}

/** 用一次探测结果替换/写入某个 serverId 的缓存条目，套用全部三条上限。 */
export function setToolNameCacheEntry(
  cache: McpToolNameCache,
  serverId: string,
  input: SetToolNameCacheEntryInput,
): McpToolNameCache {
  if (!serverId) throw new Error('MCP 工具名缓存必须提供 serverId')
  const tools = input.tools
    .map(sanitizeToolEntry)
    .filter((entry): entry is McpToolNameCacheEntry => entry !== undefined)
    .slice(0, MCP_TOOL_NAME_CACHE_MAX_TOOLS_PER_SERVER)
  const record: McpToolNameCacheRecord = {
    tools,
    toolCount: input.tools.length,
    cachedAt: input.cachedAt ?? Date.now(),
    probeStatus: input.probeStatus,
  }
  return insertRecordWithBudget(cache, serverId, record)
}

/** 移除某个 serverId 的缓存条目（例如该服务被删除时）；未命中原样返回。 */
export function removeToolNameCacheEntry(
  cache: McpToolNameCache,
  serverId: string,
): McpToolNameCache {
  if (!(serverId in cache)) return cache
  const next = { ...cache }
  delete next[serverId]
  return next
}

/**
 * 一个服务【上次已知】的工具清单——缓存唯一的对外读出形状。
 *
 * 【为什么读出口另起一个类型】McpToolNameCacheRecord 是存储形状，字段名读起来像在陈述事实
 * （tools / toolCount）。这个类型把同一份数据重新包装成一句带限定的话：serverId 上次被探测到
 * （cachedAt）时的清单长这样，其中 truncated 说明它还被上限截过。取清单必然连带取到探测时刻，
 * 于是「误当成当前事实」这件事在类型层面就发生不了。
 *
 * 【为什么不在这里直接给格式化好的字符串】两个消费方要的成品不一样：给用户看的（设置面板，
 * B5）需要相对时间与本地化，属于 UI 的事；给模型看的（connect_mcp_server 的工具描述 F4、
 * core 的未连接回执 B4）要的是长度受控、时区无歧义的一行字，且措辞是协议的一部分。数据层
 * 出成品只会逼两边共用一种都不合适的措辞，所以这里只出原料——但原料的形状自带限定语。
 */
export interface McpLastKnownTools {
  readonly serverId: string
  readonly tools: readonly McpToolNameCacheEntry[]
  /** 上次探测到的工具总数；tools 被上限截断时它仍是真实总数。 */
  readonly toolCount: number
  /** tools 是否因上限被截断（toolCount > tools.length）。 */
  readonly truncated: boolean
  /** 这份清单被探测到的时刻（epoch 毫秒）。 */
  readonly cachedAt: number
  readonly probeStatus: McpToolProbeStatus
}

function toLastKnown(serverId: string, record: McpToolNameCacheRecord): McpLastKnownTools {
  return {
    serverId,
    tools: record.tools,
    toolCount: record.toolCount,
    truncated: record.toolCount > record.tools.length,
    cachedAt: record.cachedAt,
    probeStatus: record.probeStatus,
  }
}

/** 读出某个服务上次已知的工具清单；从未探测过返回 undefined（不要伪造成"没有工具"）。 */
export function readLastKnownTools(
  cache: McpToolNameCache,
  serverId: string,
): McpLastKnownTools | undefined {
  const record = cache[serverId]
  return record ? toLastKnown(serverId, record) : undefined
}

/** 读出全部服务上次已知的工具清单，供设置面板与连接工具的描述使用。 */
export function listLastKnownTools(cache: McpToolNameCache): readonly McpLastKnownTools[] {
  return Object.entries(cache).map(([serverId, record]) => toLastKnown(serverId, record))
}

/** findLastKnownToolProvider 的命中结果：这个注册名上次已知出自谁。 */
export interface McpLastKnownToolProvider {
  readonly serverId: string
  /** 服务侧的原始工具名（缓存存的是它，注册名由 toRegisteredName 拼出）。 */
  readonly remoteToolName: string
  readonly cachedAt: number
}

/**
 * 反查一个【注册名】上次已知出自哪个服务。命中不代表这个工具现在存在——它只说明
 * 上次探测时它在那个服务的清单里，所以调用方拿到它之后只能说「上次已知」。
 *
 * toRegisteredName 由调用方注入（传 tools-mcp 的 makeMcpToolName）：注册名不是简单拼接，
 * 超长或含非法字符时会退化成带哈希的形式，在这里抄一份迟早会和真身对不上。
 *
 * 只在「这个工具名彻底不认识」的冷路径上被调用，所以直接线性扫（上限 50 服务 × 200 工具）。
 */
export function findLastKnownToolProvider(
  cache: McpToolNameCache,
  toolName: string,
  toRegisteredName: (serverId: string, remoteToolName: string) => string,
): McpLastKnownToolProvider | undefined {
  if (!toolName) return undefined
  for (const [serverId, record] of Object.entries(cache)) {
    for (const entry of record.tools) {
      if (toRegisteredName(serverId, entry.name) !== toolName) continue
      return { serverId, remoteToolName: entry.name, cachedAt: record.cachedAt }
    }
  }
  return undefined
}
