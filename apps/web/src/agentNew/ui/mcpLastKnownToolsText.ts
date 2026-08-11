// 「上次已知工具清单」在设置面板上的措辞（B5）。
//
// 【为什么格式化在 UI 这一层】B4 的读出口只出原料（McpLastKnownTools：清单 + 探测时刻 +
// 是否截断），因为两个消费方要的成品不一样：给模型看的要长度受控、时区无歧义（那份在
// tools/mcp 的 lastKnownToolsText.ts），给用户看的要相对时间与本地化——就是本文件。
//
// 【一条不能破的呈现原则】这是「上次已知」，不是当前事实。所以每句话都带限定语（「上次」
// 「探测于」），绝不写成「有 N 个工具」。
//
// 【「从未探测过」与「探测到 0 个工具」必须分开说】前者是我们不知道，后者是我们知道它当时
// 没有工具。都写成「0 个工具」会让用户以为这个服务没用、进而删掉一个其实只是还没探测过的
// 服务。数据层已经把这两种分开了（从未探测 → readLastKnownTools 返回 undefined），
// 呈现层不能又把它们合回去。

import type { McpLastKnownTools } from '../../mcp/toolNameCache'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/**
 * Date 能表示的绝对毫秒上限。超出这个范围 toLocaleString 不抛错，而是安静地返回
 * 「Invalid Date」——那正是最坏的一种失败：一句看起来像时间的假话直接进了界面。
 * 所以这里自己先判一次，与 tools/mcp 的 lastKnownTools.ts 同一个判据。
 */
const MAX_SAFE_EPOCH_MS = 8.64e15

function isUsableTimestamp(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= MAX_SAFE_EPOCH_MS
}

/**
 * 探测时刻的相对说法。
 *
 * 未来时间（本机时钟回拨、配置从别处拷来）按「刚刚」说：与其显示「-3 天前」这种一看就
 * 坏掉的东西，不如给一个不精确但不误导的说法。时间戳不可用时如实说「时间未知」，不猜。
 */
export function formatProbedAt(cachedAt: number, now: number = Date.now()): string {
  if (!isUsableTimestamp(cachedAt)) return '时间未知'
  const elapsed = now - cachedAt
  if (elapsed < MINUTE_MS) return '刚刚'
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)} 分钟前`
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)} 小时前`
  if (elapsed < 30 * DAY_MS) return `${Math.floor(elapsed / DAY_MS)} 天前`
  return new Date(cachedAt).toLocaleDateString('zh-CN')
}

/** 鼠标悬停时给出的精确时刻；不可用时不给 title，而不是给一句假的。 */
export function formatProbedAtExact(cachedAt: number): string | undefined {
  if (!isUsableTimestamp(cachedAt)) return undefined
  return `探测于 ${new Date(cachedAt).toLocaleString('zh-CN')}`
}

/**
 * 未连接服务在卡片上那一行字。
 *
 * 从未探测过（lastKnown === undefined）与探测到 0 个工具是两句不同的话，见文件头。
 */
export function describeLastKnownTools(lastKnown: McpLastKnownTools | undefined, now?: number): string {
  if (!lastKnown) return '尚未探测过工具清单'
  const probedAt = formatProbedAt(lastKnown.cachedAt, now)
  if (lastKnown.probeStatus !== 'success') return `上次探测未成功 · ${probedAt}`
  if (lastKnown.toolCount === 0) return `上次探测到 0 个工具 · ${probedAt}`
  return `上次可用工具 ${lastKnown.toolCount} 个 · ${probedAt}`
}
