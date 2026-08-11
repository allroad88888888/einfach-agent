// 「上次已知工具清单」的措辞（B5）。两条硬判据：
//   · 每句话都带限定语——这是历史，不是当前事实；
//   · 「从未探测过」与「探测到 0 个工具」是两句不同的话。

import { describe, expect, it } from 'vitest'
import type { McpLastKnownTools } from '../../mcp/toolNameCache'
import { describeLastKnownTools, formatProbedAt, formatProbedAtExact } from './mcpLastKnownToolsText'

const NOW = Date.UTC(2026, 7, 10, 12, 0, 0)

function lastKnown(overrides: Partial<McpLastKnownTools> = {}): McpLastKnownTools {
  return {
    serverId: 'docs',
    tools: [{ name: 'search', description: '搜索文档' }],
    toolCount: 1,
    truncated: false,
    cachedAt: NOW - 90 * 60_000,
    probeStatus: 'success',
    ...overrides,
  }
}

describe('formatProbedAt', () => {
  it('按新鲜度给相对时间', () => {
    expect(formatProbedAt(NOW - 5_000, NOW)).toBe('刚刚')
    expect(formatProbedAt(NOW - 5 * 60_000, NOW)).toBe('5 分钟前')
    expect(formatProbedAt(NOW - 3 * 3_600_000, NOW)).toBe('3 小时前')
    expect(formatProbedAt(NOW - 5 * 86_400_000, NOW)).toBe('5 天前')
  })

  it('超过 30 天改用本地日期，别让用户去数「87 天前」是什么时候', () => {
    expect(formatProbedAt(NOW - 87 * 86_400_000, NOW)).toContain('2026')
  })

  it('时间戳不可用就如实说时间未知，不猜也不编', () => {
    expect(formatProbedAt(Number.NaN, NOW)).toBe('时间未知')
    expect(formatProbedAt(Number.POSITIVE_INFINITY, NOW)).toBe('时间未知')
    // 超出 Date 可表示范围（toLocaleDateString 会抛 RangeError）也不能崩。
    expect(formatProbedAt(-1e18, NOW)).toBe('时间未知')
  })

  it('本机时钟回拨导致的未来时间按「刚刚」说，不显示负数', () => {
    expect(formatProbedAt(NOW + 86_400_000, NOW)).toBe('刚刚')
  })

  it('精确时刻不可用时不给 title，而不是给一句假的', () => {
    expect(formatProbedAtExact(NOW)).toContain('探测于')
    expect(formatProbedAtExact(Number.NaN)).toBeUndefined()
    expect(formatProbedAtExact(1e18)).toBeUndefined()
  })
})

describe('describeLastKnownTools', () => {
  it('有清单时说「上次可用工具 N 个」并带上探测时间', () => {
    expect(describeLastKnownTools(lastKnown({ toolCount: 4 }), NOW))
      .toBe('上次可用工具 4 个 · 1 小时前')
  })

  it('N 用的是探测到的真实总数，即使清单被上限截断过', () => {
    expect(describeLastKnownTools(lastKnown({ toolCount: 260, truncated: true }), NOW))
      .toContain('上次可用工具 260 个')
  })

  it('「从未探测过」与「探测到 0 个工具」是两句不同的话', () => {
    expect(describeLastKnownTools(undefined, NOW)).toBe('尚未探测过工具清单')
    expect(describeLastKnownTools(lastKnown({ toolCount: 0, tools: [] }), NOW))
      .toBe('上次探测到 0 个工具 · 1 小时前')
  })

  it('上次探测失败也不能说成「0 个工具」', () => {
    expect(describeLastKnownTools(
      lastKnown({ toolCount: 0, tools: [], probeStatus: 'failed' }),
      NOW,
    )).toBe('上次探测未成功 · 1 小时前')
  })

  it('每一句都带限定语，不会被读成当前事实', () => {
    for (const value of [
      describeLastKnownTools(lastKnown(), NOW),
      describeLastKnownTools(lastKnown({ toolCount: 0, tools: [] }), NOW),
      describeLastKnownTools(lastKnown({ probeStatus: 'failed' }), NOW),
      describeLastKnownTools(undefined, NOW),
    ]) {
      expect(value).toMatch(/上次|尚未/)
    }
  })
})
