import { describe, expect, it } from 'vitest'
import { replaySubagentArchive } from './subagent-replay-lib.js'

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
})
