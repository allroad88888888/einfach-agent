import { describe, expect, it } from 'vitest'
import {
  parseSubagentEvents,
  parseSubagentTreeSnapshot,
  replaySubagentArchive,
} from './replay'

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

describe('parseSubagentEvents', () => {
  it('keeps valid lines and reports invalid json/shape', () => {
    const text = `${JSON.stringify(
      event(),
    )}\n{invalid json}\n${JSON.stringify({ ...event(), type: 'child_started' })}\n${JSON.stringify({ foo: 'bar' })}`

    const result = parseSubagentEvents(text)

    expect(result.records).toHaveLength(2)
    expect(result.parseErrors).toHaveLength(2)
    expect(result.parseErrors.some((item) => item.error.includes('invalid subagent archive event structure'))).toBe(true)
  })
})

describe('replaySubagentArchive', () => {
  it('replays events into a deterministic node map and child result list', () => {
    const eventsText = [
      JSON.stringify(event()),
      JSON.stringify({
        ...event({ eventId: 'ev-02', type: 'delegate_requested', agentPath: 'root' }),
      }),
      JSON.stringify({
        ...event({ eventId: 'ev-03', type: 'children_reserved', agentPath: 'root', data: { paths: ['root-01', 'root-02'] } }),
      }),
      JSON.stringify({
        ...event({ eventId: 'ev-04', type: 'child_started', agentPath: 'root-01', data: { skillId: 'sk-01', inheritedSkillIds: ['sk-parent'] } }),
      }),
      JSON.stringify({
        ...event({
          eventId: 'ev-05',
          type: 'child_finished',
          agentPath: 'root-01',
          data: { status: 'done', resultFile: 'result-01.md', summary: 'ok', skillIds: ['sk-01'], skillFiles: ['a.md'] },
        }),
      }),
      JSON.stringify({
        ...event({ eventId: 'ev-06', type: 'child_started', agentPath: 'root-02', data: { skillId: 'sk-02' } }),
      }),
      JSON.stringify({
        ...event({ eventId: 'ev-07', type: 'tree_snapshot_written', agentPath: 'root', data: { nodes: 1 } }),
      }),
    ].join('\n')

    const treeText = JSON.stringify({
      nodes: [
        {
          id: 'r1:root',
          treeId: 'r1',
          sessionId: 'c1',
          path: 'root',
          status: 'running',
          objective: 'root objective',
          depth: 0,
          childCounter: 1,
          createdAt: 1,
          updatedAt: 1,
          inheritedSkillFiles: ['parent.md'],
          inheritedSkillIds: ['sk-parent'],
          localSkillFiles: [],
          localSkillIds: [],
        },
      ],
    })

    const result = replaySubagentArchive({ eventsText, treeText })

    expect(result.conversationId).toBe('c1')
    expect(result.runId).toBe('r1')
    expect(result.treeId).toBe('r1')
    expect(result.eventCounts.child_finished).toBe(1)
    expect(result.eventCounts.children_reserved).toBe(1)
    expect(result.summary.total).toBe(3)
    expect(result.summary.done).toBe(1)
    expect(result.summary.running).toBe(2) // root + running root-02
    expect(result.nodes['root-01']).toMatchObject({ status: 'done', resultFile: 'result-01.md' })
    expect(result.nodes.root).toMatchObject({ childCounter: 2 })
    expect(result.nodes['root-02']).toMatchObject({ status: 'running' })
    expect(result.childResults).toHaveLength(1)
    expect(result.childResults[0]).toMatchObject({
      path: 'root-01',
      status: 'done',
      summary: 'ok',
      skillIds: ['sk-01'],
    })
    expect(result.orderedPaths).toEqual(['root', 'root-01', 'root-02'])
  })

  it('replays dispatchCounter from children_reserved events', () => {
    const eventsText = [
      JSON.stringify(event()),
      JSON.stringify({
        ...event({ eventId: 'ev-03', type: 'children_reserved', agentPath: 'root', data: { paths: ['root-01'], dispatchCounter: 3 } }),
      }),
    ].join('\n')

    const result = replaySubagentArchive({ eventsText })

    expect(result.nodes['root']).toMatchObject({
      dispatchCounter: 3,
      status: 'running',
    })
  })

  it('merges snapshot counters with historical reservation events without double counting or regression', () => {
    const eventsText = [
      JSON.stringify(event()),
      JSON.stringify({
        ...event({
          eventId: 'ev-02',
          type: 'children_reserved',
          agentPath: 'root',
          data: { paths: ['root-01', 'root-02'], dispatchCounter: 3 },
        }),
      }),
      JSON.stringify({
        ...event({
          eventId: 'ev-03',
          type: 'children_reserved',
          agentPath: 'root',
          data: { paths: ['root-03'], dispatchCounter: 4 },
        }),
      }),
    ].join('\n')

    const treeText = JSON.stringify({
      nodes: [
        {
          id: 'r1:root',
          treeId: 'r1',
          sessionId: 'c1',
          path: 'root',
          status: 'running',
          objective: 'root objective',
          depth: 0,
          dispatchCounter: 5,
          childCounter: 3,
          createdAt: 1,
          updatedAt: 1,
          inheritedSkillFiles: [],
          inheritedSkillIds: [],
          localSkillFiles: [],
          localSkillIds: [],
        },
      ],
    })

    const result = replaySubagentArchive({ eventsText, treeText })

    expect(result.nodes.root).toMatchObject({
      childCounter: 3,
      dispatchCounter: 5,
    })
    expect(result.orderedPaths).toEqual(['root', 'root-01', 'root-02', 'root-03'])
  })

  it('replays complete result metadata and preserves cancelled status', () => {
    const eventsText = [
      JSON.stringify(event()),
      JSON.stringify({
        ...event({
          eventId: 'ev-02',
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
        }),
      }),
    ].join('\n')

    const result = replaySubagentArchive({ eventsText })

    expect(result.nodes['root-01']).toMatchObject({
      status: 'cancelled',
      objective: 'inspect cancellation semantics',
      resultFile: 'result-01.md',
      error: 'aborted',
      localSkillIds: ['sk-01'],
      localSkillFiles: ['skill-01.md'],
    })
    expect(result.childResults).toEqual([
      {
        path: 'root-01',
        status: 'cancelled',
        objective: 'inspect cancellation semantics',
        summary: 'cancelled by caller',
        resultFile: 'result-01.md',
        skillFiles: ['skill-01.md'],
        skillIds: ['sk-01'],
        error: 'aborted',
      },
    ])
    expect(result.summary.cancelled).toBe(1)
  })

  it('finishes the root node from events without a tree snapshot', () => {
    const eventsText = [
      JSON.stringify(event()),
      JSON.stringify(event({
        eventId: 'ev-02',
        type: 'delegate_finished',
        agentPath: 'root',
        data: { status: 'done' },
      })),
    ].join('\n')

    const result = replaySubagentArchive({ eventsText })

    expect(result.nodes.root.status).toBe('done')
    expect(result.summary).toMatchObject({ total: 1, running: 0, done: 1 })
  })

  it('survives malformed snapshot entries and creates fallback nodes from event stream', () => {
    const badTree = JSON.stringify({ nodes: [{}] })
    const parsed = parseSubagentTreeSnapshot(badTree)
    expect(parsed.records).toHaveLength(1)
    expect(parsed.parseErrors).toHaveLength(1)
    expect(parseSubagentTreeSnapshot('  ')).toEqual({ records: [], parseErrors: [] })

    const eventsText = JSON.stringify({
      ...event(),
      type: 'child_started',
      agentPath: 'root-99',
      data: { skillId: 'sk-99' },
    })

    const result = replaySubagentArchive({ eventsText })

    expect(result.nodes['root-99']).toMatchObject({ status: 'running', path: 'root-99' })
    expect(result.summary.total).toBe(1)
  })
})

// 子 agent 压缩的两类事件是后加的（对齐主循环的 llm.context_compacted / llm.context_over_budget）。
// 它们必须同时出现在 types.ts 的 SubagentArchiveEventType 联合【和】replay.ts 的
// SUBAGENT_EVENT_TYPES 白名单里 —— 只加联合不加白名单，isSubagentArchiveEvent 会把它判成
// 结构非法丢进 parseErrors，排查者在 eventCounts 里就再也看不到「这个子 agent 被压过」。
describe('replay 认得子 agent 模型遥测事件', () => {
  const telemetryTypes = [
    'child_model_usage',
    'child_context_compacted',
    'child_context_over_budget',
  ] as const

  it('usage 与两类压缩事件都进 records 而不是 parseErrors', () => {
    const text = telemetryTypes
      .map((type, i) => JSON.stringify({ ...event(), eventId: `ev-${i}`, type, agentPath: 'root-01' }))
      .join('\n')

    const result = parseSubagentEvents(text)

    expect(result.parseErrors).toHaveLength(0)
    expect(result.records.map((r) => r.type)).toEqual([...telemetryTypes])
  })

  it('eventCounts 统计它们（初始表漏一个键就会是 NaN/undefined）', () => {
    const text = [
      JSON.stringify(event()),
      JSON.stringify({ ...event(), eventId: 'ev-1', type: 'child_model_usage', agentPath: 'root-01' }),
      JSON.stringify({ ...event(), eventId: 'ev-2', type: 'child_context_compacted', agentPath: 'root-01' }),
      JSON.stringify({ ...event(), eventId: 'ev-3', type: 'child_context_compacted', agentPath: 'root-02' }),
      JSON.stringify({ ...event(), eventId: 'ev-4', type: 'child_context_over_budget', agentPath: 'root-02' }),
    ].join('\n')

    const state = replaySubagentArchive({ eventsText: text })

    expect(state.eventCounts.child_model_usage).toBe(1)
    expect(state.eventCounts.child_context_compacted).toBe(2)
    expect(state.eventCounts.child_context_over_budget).toBe(1)
    // 没发生过的类型必须是 0 而不是 undefined —— 初始表少一个键，UI 上就会显示成空白而非「0 次」。
    expect(state.eventCounts.child_finished).toBe(0)
  })
})
