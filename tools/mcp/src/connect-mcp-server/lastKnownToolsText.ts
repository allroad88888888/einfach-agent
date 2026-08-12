// tools/mcp/src/connect-mcp-server/lastKnownToolsText.ts —— 「上次已知」清单给模型看的两段文案，
// 以及呈现侧的字符上限。裁剪算法在 lastKnownToolsBudget.ts，本文件只负责【怎么说】。
//
// 【为什么不再逐条列工具名】透明连接上线后（D2/D3b），有【上次已知】清单的未连接服务，其工具已经
//   作为占位工具注册进 ToolRegistry、以真名字出现在模型每次都能看到的工具清单里——模型要找
//   "create issue"，直接命中 `mcp__github__create_issue` 这个占位条目本身即可，用不着
//   connect_mcp_server 的 description 再抄一遍同样的名字。继续抄等于每次请求为同一份信息多付
//   一遍上下文（蓝图第七节「文案去重」）。
//   于是本工具的 description/guide 收窄成两件事：
//   ① 一句总览——多少服务未连接、已知工具已经在工具清单里可以直接调用；
//   ② 占位机制覆盖不到的部分——【没有已知清单】的服务（探测失败/从未探测/空清单）没有占位工具，
//      模型没有别的办法看见它们，这部分必须继续按 ID 点名，否则它们对模型彻底不存在。
//
// 【manifest 与 guide 仍分两层，理由不同了】manifest（skill.description）进 ToolRegistry.list()，
//   每次模型请求都要发，所以只留总数、无清单服务的 ID、以及一句提示；guide（skill.content）只在
//   模型主动 request_tool_schema 时给一次，补上诊断细节：每个已知服务上次探测的 UTC 时间与工具
//   总数，以及每个无清单服务的具体原因。两层都不再展开单条工具名——那部分信息已经由占位工具自己
//   的 description 承担。
//
// 【为什么处处写"上次已知"和 UTC 时间戳】MCP 有 tools/list_changed，工具集会变。这里的数字与
//   时间只是历史，连上之后一律以服务返回的真实清单为准；写明这一点，模型才不会把占位或诊断数据
//   当成保证。
import { truncate } from '../internal'
import type { McpLastKnownDigest, McpLastKnownGap, McpLastKnownToolList } from './lastKnownTools'
import { fitEntriesToBudget, type BudgetedEntry } from './lastKnownToolsBudget'

/** manifest 里这一整段（含前后缀）的字符上限。每次请求都要发，所以卡得比 guide 紧一个数量级。 */
export const MCP_CONNECT_MANIFEST_MAX_CHARS = 1_200
/** manifest 摘要里最多点名几个「无已知清单」的服务 ID，其余只报数量，不静默丢弃。 */
const MANIFEST_MAX_GAP_IDS = 20
const MANIFEST_SERVER_ID_MAX_CHARS = 60

/** guide 里这一整段的字符上限。只在 request_tool_schema 时给一次，可以宽松得多。 */
export const MCP_CONNECT_GUIDE_MAX_CHARS = 6_000
export const MCP_CONNECT_GUIDE_MAX_SERVERS = 50
const GUIDE_SERVER_ID_MAX_CHARS = 120
const GUIDE_MAX_GAP_IDS = 20

const GAP_MEANING = '暂无已知清单（不等于没有工具，连上后才知道）'
/** manifest 与 guide 共用的一句话：占位机制已经接管"发现已知能力"这条路。 */
const KNOWN_TOOLS_NOTE = '已知工具已直接出现在工具清单里，可直接调用（调用会自动连接）'
const MANIFEST_GUIDE_POINTER = '各服务的探测时间、工具数量与失败原因，用 request_tool_schema 取本工具说明。'

const GAP_REASON_TEXT: Readonly<Record<McpLastKnownGap['reason'], string>> = {
  never_probed: '尚未探测过',
  probe_failed: '上次探测失败',
  no_tools: '上次探测到空清单',
}

function utcTimestamp(cachedAt: number): string {
  return new Date(cachedAt).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** 把 gap 列表渲染成「id、id、id，以及另外 N 个」，两层（manifest/guide）共用同一条裁剪规则。 */
function gapIdList(gaps: readonly McpLastKnownGap[], maxIds: number, idMaxChars: number): string {
  const shown = gaps.slice(0, maxIds)
  const ids = shown.map((gap) => truncate(gap.serverId, idMaxChars)).join('、')
  const omitted = gaps.length - shown.length
  return omitted > 0 ? `${ids}，以及另外 ${omitted} 个` : ids
}

/* ------------------------------ manifest 层 ------------------------------ */

/**
 * 追加到工具 description 后面的那一段。digest 为 undefined（探针未接线或宿主抛错）→ 返回空串，
 * 一个字都不编。
 *
 * 只报三件事（蓝图第七节「文案去重」的判据）：未连接服务的总数、【无已知清单】的服务 ID（必须
 * 点名——它们没有占位工具，manifest 是模型能看见它们的唯一地方）、以及提醒已知工具已经作为占位
 * 可以直接调用。逐条工具名不再出现在这里：那些名字已经是真实注册的占位工具，本身就在模型每次
 * 看到的工具清单里，重复列一遍只是双倍付费同一份信息。
 */
export function buildLastKnownManifestNote(digest: McpLastKnownDigest | undefined): string {
  if (!digest) return ''
  const { listed, gaps } = digest
  const total = listed.length + gaps.length
  if (total === 0) return ''

  const gapPart = gaps.length > 0
    ? `，其中 ${gaps.length} 个${GAP_MEANING}：${gapIdList(gaps, MANIFEST_MAX_GAP_IDS, MANIFEST_SERVER_ID_MAX_CHARS)}`
    : ''
  const note = `\n当前 ${total} 个已配置的 MCP 服务未连接${gapPart}。${KNOWN_TOOLS_NOTE}。${MANIFEST_GUIDE_POINTER}`
  // 兜底：正常情况下远小于上限，这里再钉死一次，让"每次请求要多付多少上下文"是个常数。
  return truncate(note, MCP_CONNECT_MANIFEST_MAX_CHARS)
}

/* -------------------------------- guide 层 -------------------------------- */

/**
 * 一个【有已知清单】服务在 guide 里的一行：只给上次探测时间与工具总数，不列任何工具名——
 * 那些已经在占位工具自己的 description 里。没有可再裁的子条目，一旦预算超限就整条服务一起丢，
 * 由调用方把丢弃数写进文案（呼应 fitEntriesToBudget 的"先瘦最胖的，再整条丢"，这里每条都已经
 * 是最瘦的形态，所以直接进入整条丢弃）。
 */
function guideListedEntry(server: McpLastKnownToolList): BudgetedEntry {
  const serverId = truncate(server.serverId, GUIDE_SERVER_ID_MAX_CHARS)
  const line = `- ${serverId} —— 上次已知 ${utcTimestamp(server.cachedAt)} · 共 ${server.toolCount} 个工具`
  return { items: [], render: () => line }
}

function guideGapSection(gaps: readonly McpLastKnownGap[]): string {
  if (gaps.length === 0) return ''
  const shown = gaps.slice(0, GUIDE_MAX_GAP_IDS)
  const listedIds = shown
    .map((gap) => `${truncate(gap.serverId, GUIDE_SERVER_ID_MAX_CHARS)}（${GAP_REASON_TEXT[gap.reason]}）`)
    .join('、')
  const omitted = gaps.length - shown.length
  return `\n\n### 暂无已知清单的未连接服务\n${listedIds}${omitted > 0 ? `，以及另外 ${omitted} 个` : ''}。`
    + `\n这些服务不是「没有工具」，只是还不知道有哪些；需要时可以直接用服务 ID 连上看。`
}

const GUIDE_HEADER = '\n\n## 未连接服务的【上次已知】工具\n'
  + '下面只给每个未连接服务上次探测的时间与工具数量，用来判断要不要显式预热、或者该诊断哪一个——'
  + '具体的工具名与简介已经作为占位工具出现在你看到的工具清单里，直接调用 `mcp__<服务>__<工具>` '
  + '会自动连接再执行，不必先来这里确认。**这是历史，不是当前事实**：连接后一律以服务返回的真实 '
  + '`tools` 为准。时间为 UTC。\n\n'

/**
 * 追加到 guide（skill.content）后面的那一节。digest 为 undefined → 返回空串。
 *
 * 这里比 manifest 多给的东西：每个已知服务精确到秒的 UTC 探测时间与工具总数、拿不到清单的服务
 * 及原因、以及因长度上限被整条丢弃的服务数——不再列出任何单条工具名或短描述，那些已经在占位
 * 工具自己的 description 里，模型请求它的 schema 或者直接调用就能看到。
 */
export function buildLastKnownGuideSection(digest: McpLastKnownDigest | undefined): string {
  if (!digest) return ''
  const { listed, gaps } = digest
  if (listed.length === 0 && gaps.length === 0) return ''

  const gapSection = guideGapSection(gaps)
  if (listed.length === 0) {
    // 只有「无清单」的服务：没有可展开的探测记录，直接给 gap 一节，不必先印一段空标题。
    return truncate(gapSection, MCP_CONNECT_GUIDE_MAX_CHARS)
  }

  const shown = listed.slice(0, MCP_CONNECT_GUIDE_MAX_SERVERS)
  const budget = MCP_CONNECT_GUIDE_MAX_CHARS - GUIDE_HEADER.length - gapSection.length
  const fitted = fitEntriesToBudget(shown.map(guideListedEntry), budget, '\n')
  const droppedServers = listed.length - shown.length + fitted.droppedEntries
  const droppedNote = droppedServers > 0
    ? `\n\n（还有 ${droppedServers} 个未连接服务因长度上限未列出，可以直接用服务 ID 连接查看。）`
    : ''

  return truncate(
    `${GUIDE_HEADER}${fitted.text}${droppedNote}${gapSection}`,
    MCP_CONNECT_GUIDE_MAX_CHARS,
  )
}
