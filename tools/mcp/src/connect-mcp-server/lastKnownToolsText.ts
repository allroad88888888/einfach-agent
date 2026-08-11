// tools/mcp/src/connect-mcp-server/lastKnownToolsText.ts —— 「上次已知」清单给模型看的两段文案，
// 以及呈现侧的字符上限。裁剪算法在 lastKnownToolsBudget.ts，本文件只负责【怎么说】。
//
// 【为什么工具名进 manifest、短描述留给 guide】这是本 issue 唯一真正的取舍，两层各有各的代价：
//   · description 进 ToolRegistry.list()，也就是【每一次模型请求】都发一遍——最贵，但它是模型
//     在不花任何回合的前提下唯一能看到的东西。
//   · skill.content（guide）只在模型主动 request_tool_schema 时给一次——几乎免费，但模型得先
//     决定"我要加载 connect_mcp_server"才拿得到。
//   MCP 改成按需连接之后，未连接服务的工具根本不在工具清单里。模型要的是"我想要的能力在哪个
//   服务里"这条路由信息；这条信息如果只躺在 guide 里，就成了死锁：模型不知道那边有东西，就不会
//   去加载这个工具的说明，于是永远不知道那边有东西，最后直接回一句"我没有这个能力"。所以【工具名
//   必须进 description】——名字就是路由键，模型找 "create issue" 时，命中 `create_issue` 这个名字
//   比命中一段散文可靠得多。
//   反过来，每条工具的短描述最多 160 字符，是名字的好几倍体积，而对"该连哪个服务"的判断只有边际
//   贡献。它们留在 guide：模型来取 guide 的时刻，恰好就是它已经决定"我要连点什么"的时刻，这时
//   多给细节才划算。于是分工是：description = 路由索引（服务 → 工具名 + 探测日期），
//   guide = 完整清单（工具名 + 短描述 + 精确时间戳 + 探测失败/未探测的服务 + manifest 里放不下的）。
//
// 【为什么处处写"上次已知"和 UTC 日期】MCP 有 tools/list_changed，工具集会变。缓存里的名字只是
//   历史，连上之后一律以服务返回的真实清单为准。措辞和时间戳都是协议的一部分：没有时间戳的工具
//   清单会被当成当前事实，而模型据此直接去调一个已经改名的工具，比它压根不知道这个服务还糟。
import { truncate } from '../internal'
import type { McpLastKnownDigest, McpLastKnownGap, McpLastKnownToolList } from './lastKnownTools'
import { fitEntriesToBudget, type BudgetedEntry } from './lastKnownToolsBudget'

/** manifest 里这一整段（含前后缀）的字符上限。每次请求都要发，所以卡得比 guide 紧一个数量级。 */
export const MCP_CONNECT_MANIFEST_MAX_CHARS = 1_200
/** 留给前缀与尾注的固定额度，其余才是条目预算。 */
const MCP_CONNECT_MANIFEST_RESERVED_CHARS = 240
export const MCP_CONNECT_MANIFEST_MAX_SERVERS = 12
export const MCP_CONNECT_MANIFEST_MAX_TOOLS_PER_SERVER = 12
const MANIFEST_SERVER_ID_MAX_CHARS = 60
const MANIFEST_TOOL_NAME_MAX_CHARS = 48

/** guide 里这一整段的字符上限。只在 request_tool_schema 时给一次，可以宽松得多。 */
export const MCP_CONNECT_GUIDE_MAX_CHARS = 6_000
export const MCP_CONNECT_GUIDE_MAX_SERVERS = 50
export const MCP_CONNECT_GUIDE_MAX_TOOLS_PER_SERVER = 40
const GUIDE_TOOL_DESCRIPTION_MAX_CHARS = 100
const GUIDE_SERVER_ID_MAX_CHARS = 120
const GUIDE_TOOL_NAME_MAX_CHARS = 120
const GUIDE_MAX_GAP_IDS = 20

const MANIFEST_PREFIX =
  '\n未连接服务的【上次已知】工具（UTC 日期，可能已过期；连上后一律以服务返回的真实清单为准）：'
const MANIFEST_FOOTER = '完整清单与每个工具的简介，用 request_tool_schema 取本工具说明。'
const GAP_MEANING = '暂无已知清单（不等于没有工具，连上后才知道）'

const GAP_REASON_TEXT: Readonly<Record<McpLastKnownGap['reason'], string>> = {
  never_probed: '尚未探测过',
  probe_failed: '上次探测失败',
  no_tools: '上次探测到空清单',
}

function utcDate(cachedAt: number): string {
  return new Date(cachedAt).toISOString().slice(0, 10)
}

function utcTimestamp(cachedAt: number): string {
  return new Date(cachedAt).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/* ------------------------------ manifest 层 ------------------------------ */

function manifestEntry(server: McpLastKnownToolList): BudgetedEntry {
  const serverId = truncate(server.serverId, MANIFEST_SERVER_ID_MAX_CHARS)
  const names = server.tools
    .slice(0, MCP_CONNECT_MANIFEST_MAX_TOOLS_PER_SERVER)
    .map((tool) => truncate(tool.name, MANIFEST_TOOL_NAME_MAX_CHARS))
  return {
    items: names,
    render(items) {
      // 省略号只表示"还有没列出来的"，真实总数由"共 N 个"承担——两者必须同时在场：
      // 只给省略号模型不知道差多少，只给总数模型会以为列出来的就是全部。
      const more = server.toolCount > items.length ? '…' : ''
      return `${serverId}（${utcDate(server.cachedAt)}，共 ${server.toolCount} 个）${items.join('、')}${more}`
    },
  }
}

function manifestNotes(droppedServers: number, gapCount: number): string {
  const notes: string[] = []
  if (droppedServers > 0) notes.push(`另有 ${droppedServers} 个未连接服务的清单因长度上限未展开`)
  if (gapCount > 0) notes.push(`另有 ${gapCount} 个未连接服务${GAP_MEANING}`)
  return notes.length > 0 ? `${notes.join('；')}。` : ''
}

/**
 * 未连接服务一个都没列出来（全都拿不到清单）时的退路。
 * 仍然要说话：让模型知道"这些服务存在、但清单未知"，而不是让它们从上下文里彻底消失。
 */
function gapOnlyNote(gapCount: number): string {
  return `\n有 ${gapCount} 个已配置但未连接的 MCP 服务${GAP_MEANING}；`
    + `是哪些服务、为什么没有清单，用 request_tool_schema 取本工具说明。`
}

/**
 * 追加到工具 description 后面的那一段。digest 为 undefined（探针未接线或宿主抛错）→ 返回空串，
 * 一个字都不编。
 */
export function buildLastKnownManifestNote(digest: McpLastKnownDigest | undefined): string {
  if (!digest) return ''
  const { listed, gaps } = digest
  if (listed.length === 0) {
    return gaps.length > 0 ? gapOnlyNote(gaps.length) : ''
  }

  const shown = listed.slice(0, MCP_CONNECT_MANIFEST_MAX_SERVERS)
  const fitted = fitEntriesToBudget(
    shown.map(manifestEntry),
    MCP_CONNECT_MANIFEST_MAX_CHARS - MCP_CONNECT_MANIFEST_RESERVED_CHARS,
    '；',
  )
  const droppedServers = listed.length - shown.length + fitted.droppedEntries
  if (!fitted.text) {
    // 防御分支：单条的最小渲染（服务名 + 一个工具名）远小于预算，正常情况下走不到这里。
    // 真走到了也不能沉默，更不能说成"暂无清单"——它们是有清单的，只是一个都没塞下。
    return `\n有 ${droppedServers + gaps.length} 个已配置但未连接的 MCP 服务，其工具清单未能在此展开；`
      + `用 request_tool_schema 取本工具说明查看。`
  }

  const note = `${MANIFEST_PREFIX}${fitted.text}。`
    + `${manifestNotes(droppedServers, gaps.length)}${MANIFEST_FOOTER}`
  // 兜底：预留额度按构造够用，这里再钉死一次上限，让"每次请求要多付多少上下文"是个常数。
  return truncate(note, MCP_CONNECT_MANIFEST_MAX_CHARS)
}

/* -------------------------------- guide 层 -------------------------------- */

function guideToolLine(name: string, description: string): string {
  const shownName = truncate(name, GUIDE_TOOL_NAME_MAX_CHARS)
  const shownDescription = truncate(description.trim(), GUIDE_TOOL_DESCRIPTION_MAX_CHARS)
  return shownDescription ? `- ${shownName} —— ${shownDescription}` : `- ${shownName}`
}

function guideEntry(server: McpLastKnownToolList): BudgetedEntry {
  const serverId = truncate(server.serverId, GUIDE_SERVER_ID_MAX_CHARS)
  const lines = server.tools
    .slice(0, MCP_CONNECT_GUIDE_MAX_TOOLS_PER_SERVER)
    .map((tool) => guideToolLine(tool.name, tool.description))
  return {
    items: lines,
    render(items) {
      const omitted = server.toolCount - items.length
      const head = omitted > 0
        ? `### ${serverId}\n上次已知 ${utcTimestamp(server.cachedAt)} · 共 ${server.toolCount} 个工具 · 此处列出 ${items.length} 个`
        : `### ${serverId}\n上次已知 ${utcTimestamp(server.cachedAt)} · 共 ${server.toolCount} 个工具`
      return [head, ...items].join('\n')
    },
  }
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

/**
 * 追加到 guide（skill.content）后面的那一节。digest 为 undefined → 返回空串。
 *
 * 这里比 manifest 多给的东西：每个工具的短描述、精确到秒的 UTC 时间戳、拿不到清单的服务及原因、
 * 以及 manifest 因长度上限没能展开的那些服务。模型来取 guide 时已经在考虑连接了，这些细节
 * 正好用来决定"连哪个"。
 */
export function buildLastKnownGuideSection(digest: McpLastKnownDigest | undefined): string {
  if (!digest) return ''
  const { listed, gaps } = digest
  if (listed.length === 0 && gaps.length === 0) return ''

  const shown = listed.slice(0, MCP_CONNECT_GUIDE_MAX_SERVERS)
  const gapSection = guideGapSection(gaps)
  const header = '\n\n## 未连接服务的【上次已知】工具\n'
    + '下面是各【未连接】的已配置服务上次被探测到的工具清单，用来判断「该连哪个服务」。'
    + '**这是历史，不是当前事实**：工具可能已经改名、下线或换了参数，而且这些名字现在都还没注册，'
    + '不要直接去调。连接成功后一律以本工具返回的 `tools` 为准。时间为 UTC。\n\n'
  const budget = MCP_CONNECT_GUIDE_MAX_CHARS - header.length - gapSection.length
  const fitted = fitEntriesToBudget(shown.map(guideEntry), budget, '\n\n')
  const droppedServers = listed.length - shown.length + fitted.droppedEntries
  const droppedNote = droppedServers > 0
    ? `\n\n（还有 ${droppedServers} 个未连接服务的清单因长度上限未列出。需要它们时可以直接用服务 ID 连上看。）`
    : ''

  const body = fitted.text || '（本次没有可展开的清单。）'
  return truncate(`${header}${body}${droppedNote}${gapSection}`, MCP_CONNECT_GUIDE_MAX_CHARS)
}
