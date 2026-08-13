import { describe, expect, it } from 'vitest'
import { parseSubagentEvents, replaySubagentArchive } from './replay'

// route_reason 是写进归档事件流的持久化标识：改核心枚举的措辞不能让老归档回放失败。
// 这里的夹具刻意混用「去厂商化之前的旧值」「当前值」「回放器完全不认识的值」，锁住
// 读回侧的契约——不透明透传，不做枚举校验，不做归一化。
//
// 旧值 → 新值对照（语义等价，仅去掉写死的厂商名）：
//   non_deepseek_provider_uses_parent_model → unrouted_provider_uses_parent_model
//   custom_deepseek_model_uses_parent_model → custom_model_uses_parent_model
const LEGACY_ROUTE_REASONS = [
  'non_deepseek_provider_uses_parent_model',
  'custom_deepseek_model_uses_parent_model',
] as const
const CURRENT_ROUTE_REASONS = [
  'unrouted_provider_uses_parent_model',
  'custom_model_uses_parent_model',
] as const

function event(overrides: Record<string, unknown> = {}) {
  return {
    eventId: 'ev-01',
    type: 'archive_initialized',
    timestamp: '2026-07-09T01:00:00.000Z',
    conversationId: 'c1',
    runId: 'r1',
    treeId: 'r1',
    agentPath: 'root',
    ...overrides,
  }
}

function archiveWithRouteReasons(reasons: readonly string[]): string {
  const lines = [JSON.stringify(event())]
  reasons.forEach((reason, index) => {
    const path = `root-0${index + 1}`
    lines.push(JSON.stringify(event({
      eventId: `ev-start-${index + 1}`,
      type: 'child_started',
      agentPath: path,
      data: { objective: `child ${path}`, modelTier: 'pro', route_reason: reason, fallback_count: 0 },
    })))
    lines.push(JSON.stringify(event({
      eventId: `ev-finish-${index + 1}`,
      type: 'child_finished',
      agentPath: path,
      data: {
        status: 'done',
        objective: `child ${path}`,
        summary: `child ${path} done`,
        modelTier: 'pro',
        route_reason: reason,
        fallback_count: 0,
      },
    })))
  })
  return lines.join('\n')
}

describe('archive route_reason read-back compatibility', () => {
  it('replays archives written before route_reason was de-vendored', () => {
    const eventsText = archiveWithRouteReasons(LEGACY_ROUTE_REASONS)

    expect(parseSubagentEvents(eventsText).parseErrors).toEqual([])
    const result = replaySubagentArchive({ eventsText })

    expect(result.parseErrors).toEqual([])
    expect(result.summary).toMatchObject({ total: 3, done: 2 })
    expect(result.childResults.map((child) => child.routeReason)).toEqual([...LEGACY_ROUTE_REASONS])
    expect(result.childResults[0]).toMatchObject({ modelTier: 'pro', fallbackCount: 0, status: 'done' })
  })

  it('passes current and unknown route reasons through unchanged', () => {
    const reasons = [...CURRENT_ROUTE_REASONS, 'reason_from_a_future_release']
    const eventsText = archiveWithRouteReasons(reasons)

    const result = replaySubagentArchive({ eventsText })

    expect(result.parseErrors).toEqual([])
    expect(result.childResults.map((child) => child.routeReason)).toEqual(reasons)
  })

  it('leaves route_reason undefined when it is absent or not a string', () => {
    const eventsText = [
      JSON.stringify(event()),
      JSON.stringify(event({
        eventId: 'ev-02',
        type: 'child_finished',
        agentPath: 'root-01',
        data: { status: 'done', summary: 'no routing metadata' },
      })),
      JSON.stringify(event({
        eventId: 'ev-03',
        type: 'child_finished',
        agentPath: 'root-02',
        data: { status: 'done', summary: 'malformed routing metadata', route_reason: 42 },
      })),
    ].join('\n')

    const result = replaySubagentArchive({ eventsText })

    expect(result.parseErrors).toEqual([])
    expect(result.childResults.map((child) => child.routeReason)).toEqual([undefined, undefined])
  })
})
