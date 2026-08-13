import { describe, expect, it } from 'vitest'
import { formatReplayReport, replaySubagentArchive, SUBAGENT_EVENT_TYPES } from './subagent-replay-lib.js'
// 权威事件类型清单只有一份，在 subagents 包。本文件不再手抄一遍：抄写副本会和源头一起腐化，
// 却测不出腐化本身。
import { SUBAGENT_EVENT_TYPES as CANONICAL_EVENT_TYPES } from '@web-agent/subagents/archive/replay'

function event(overrides = {}) {
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

describe('subagent replay CLI library', () => {
  it('replays snapshot counters idempotently and keeps complete cancelled result metadata', () => {
    const eventsText = [
      JSON.stringify(event()),
      JSON.stringify(event({
        eventId: 'ev-02',
        type: 'children_reserved',
        data: { paths: ['root-01', 'root-02'], dispatchCounter: 3 },
      })),
      JSON.stringify(event({
        eventId: 'ev-03',
        type: 'child_finished',
        agentPath: 'root-01',
        data: {
          status: 'cancelled',
          objective: 'inspect cancellation semantics',
          summary: 'cancelled by caller',
          resultFile: 'result-01.md',
          skillIds: ['sk-01'],
          skillFiles: ['skill-01.md'],
          error: 'aborted',
        },
      })),
    ].join('\n')
    const treeText = JSON.stringify({
      nodes: [{
        id: 'r1:root',
        treeId: 'r1',
        sessionId: 'c1',
        path: 'root',
        status: 'running',
        objective: 'root objective',
        depth: 0,
        dispatchCounter: 5,
        childCounter: 2,
        createdAt: 1,
        updatedAt: 1,
        inheritedSkillFiles: [],
        inheritedSkillIds: [],
        localSkillFiles: [],
        localSkillIds: [],
      }],
    })

    const result = replaySubagentArchive({ eventsText, treeText })

    expect(result.nodes.root).toMatchObject({ childCounter: 2, dispatchCounter: 5 })
    expect(result.nodes['root-01']).toMatchObject({
      status: 'cancelled',
      objective: 'inspect cancellation semantics',
    })
    expect(result.childResults).toEqual([
      expect.objectContaining({
        path: 'root-01',
        status: 'cancelled',
        summary: 'cancelled by caller',
        skillFiles: ['skill-01.md'],
      }),
    ])
    expect(result.summary.cancelled).toBe(1)
  })

  it('finishes the root node from events without a tree snapshot', () => {
    const eventsText = [
      JSON.stringify(event()),
      JSON.stringify(event({
        eventId: 'ev-02',
        type: 'delegate_finished',
        data: { status: 'done' },
      })),
    ].join('\n')

    const result = replaySubagentArchive({ eventsText })

    expect(result.nodes.root.status).toBe('done')
    expect(result.summary).toMatchObject({ total: 1, running: 0, done: 1 })
  })

  // route_reason 在去厂商化前后取值不同，而 CLI 复盘只按事件类型统计、不解释该字段。
  // 这条锁住「老归档照样出报告」：含旧值的夹具必须零解析错误，报告正常渲染。
  it('reports archives whose route_reason predates the de-vendored values', () => {
    const eventsText = [
      JSON.stringify(event()),
      JSON.stringify(event({
        eventId: 'ev-02',
        type: 'child_started',
        agentPath: 'root-01',
        data: { objective: 'legacy child', modelTier: 'pro', route_reason: 'non_deepseek_provider_uses_parent_model' },
      })),
      JSON.stringify(event({
        eventId: 'ev-03',
        type: 'child_finished',
        agentPath: 'root-01',
        data: {
          status: 'done',
          objective: 'legacy child',
          summary: 'legacy child done',
          modelTier: 'pro',
          route_reason: 'custom_deepseek_model_uses_parent_model',
          fallback_count: 0,
        },
      })),
    ].join('\n')

    const result = replaySubagentArchive({ eventsText })

    expect(result.parseErrors).toEqual([])
    expect(result.eventCounts.child_finished).toBe(1)
    expect(result.childResults).toEqual([
      expect.objectContaining({ path: 'root-01', status: 'done', summary: 'legacy child done' }),
    ])

    const report = formatReplayReport(result)

    expect(report).toContain('# 子 Agent 复盘报告')
    expect(report).toContain('child_finished: 1')
    expect(report).toContain('`root-01` done · legacy child done')
    expect(report).toContain('### 解析异常\n\n无')
  })

  // 包新增事件类型而 CLI 白名单漏同步时，这条立刻失败——取代原来靠注释提醒的做法。
  it('keeps the CLI whitelist in lockstep with the archive schema', () => {
    expect([...SUBAGENT_EVENT_TYPES].sort()).toEqual([...CANONICAL_EVENT_TYPES].sort())
  })

  it('accepts and counts every replay event type used by agent-core', () => {
    const eventTypes = CANONICAL_EVENT_TYPES
    const eventsText = eventTypes
      .map((type, index) => JSON.stringify(event({
        eventId: `ev-${index + 1}`,
        type,
      })))
      .join('\n')

    const result = replaySubagentArchive({ eventsText })

    expect(result.parseErrors).toEqual([])
    expect(result.events).toHaveLength(eventTypes.length)
    expect(result.eventCounts).toEqual(
      Object.fromEntries(eventTypes.map((type) => [type, 1])),
    )
  })
})
