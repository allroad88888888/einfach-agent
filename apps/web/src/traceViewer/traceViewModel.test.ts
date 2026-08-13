import { describe, expect, it } from 'vitest'
import type { TraceLogSnapshot } from '@web-agent/core/observability/logReader'
import { buildTraceView, buildTraceViewModel, filterTraceRuns, filterTraceTimeline } from './traceViewModel'

function snapshot(): TraceLogSnapshot {
  return {
    source: 'indexeddb',
    loadedAt: 1000,
    spans: [
      {
        id: 'root-1',
        traceId: 'trace-1',
        name: 'agent.turn',
        kind: 'agent',
        status: 'ok',
        startedAt: 100,
        endedAt: 220,
        durationMs: 120,
        attrs: { sessionId: 's1', runId: 'r1', turnId: 'u1', vendor: 'deepseek', model: 'm1' },
      },
      {
        id: 'llm-1',
        traceId: 'trace-1',
        parentSpanId: 'root-1',
        name: 'llm.chat',
        kind: 'llm',
        status: 'ok',
        startedAt: 120,
        endedAt: 160,
        durationMs: 40,
        attrs: { sessionId: 's1', runId: 'r1', turnId: 'u1', total_tokens: 42 },
      },
      {
        id: 'tool-1',
        traceId: 'trace-1',
        parentSpanId: 'root-1',
        name: 'tool.call',
        kind: 'tool',
        status: 'error',
        startedAt: 170,
        endedAt: 210,
        durationMs: 40,
        attrs: { sessionId: 's1', runId: 'r1', turnId: 'u1', toolName: 'read_file' },
        error: 'boom',
      },
      {
        id: 'root-2',
        traceId: 'trace-2',
        name: 'agent.turn',
        kind: 'agent',
        status: 'running',
        startedAt: 300,
        attrs: { sessionId: 's1', runId: 'r2', turnId: 'u2' },
      },
    ],
    events: [
      {
        id: 'event-1',
        traceId: 'trace-1',
        spanId: 'root-1',
        name: 'checkpoint.commit',
        timestamp: 215,
        attrs: { sessionId: 's1', runId: 'r1', turnId: 'u1', turnIndex: 0 },
      },
      {
        id: 'event-2',
        traceId: 'trace-2',
        spanId: 'root-2',
        name: 'agent.waiting_user',
        timestamp: 340,
        attrs: { sessionId: 's1', runId: 'r2', turnId: 'u2', question_count: 1 },
      },
    ],
  }
}

describe('traceViewModel', () => {
  it('groups spans and events by run and summarizes turn metrics', () => {
    const view = buildTraceViewModel(snapshot())

    expect(view.totalSpans).toBe(4)
    expect(view.totalEvents).toBe(2)
    expect(view.totalRuns).toBe(2)
    expect(view.runs).toHaveLength(2)

    const doneRun = view.runs.find((run) => run.runId === 'r1')
    expect(doneRun).toMatchObject({
      sessionId: 's1',
      turnId: 'u1',
      status: 'ok',
      vendor: 'deepseek',
      model: 'm1',
      spanCount: 3,
      eventCount: 1,
      llmCount: 1,
      toolCount: 1,
      errorCount: 1,
      totalTokens: 42,
    })
    expect(doneRun?.timeline.map((item) => item.id)).toEqual([
      'span:root-1',
      'span:llm-1',
      'span:tool-1',
      'event:event-1',
    ])
    expect(doneRun?.timeline.map((item) => item.depth)).toEqual([0, 1, 1, 1])
  })

  it('records waiting state for paused turns', () => {
    const view = buildTraceViewModel(snapshot())

    expect(view.runs.find((run) => run.runId === 'r2')?.waitingState).toBe('user')
  })

  it('aggregates archive write metrics for a run', () => {
    const input = snapshot()
    input.spans.push(
      {
        id: 'archive-1',
        traceId: 'archive-trace-1',
        name: 'subagent.archive_write_summary',
        kind: 'internal',
        status: 'ok',
        startedAt: 221,
        endedAt: 221,
        durationMs: 0,
        attrs: { sessionId: 's1', runId: 'r1', archive_write_attempts: 3, archive_write_failures: 0 },
      },
      {
        id: 'archive-2',
        traceId: 'archive-trace-2',
        name: 'subagent.archive_write_summary',
        kind: 'internal',
        status: 'error',
        startedAt: 222,
        endedAt: 222,
        durationMs: 0,
        attrs: { sessionId: 's1', runId: 'r1', archive_write_attempts: 2, archive_write_failures: 1 },
      },
    )

    expect(buildTraceViewModel(input).runs.find((run) => run.runId === 'r1')).toMatchObject({
      archiveWriteAttempts: 5,
      archiveWriteFailures: 1,
      archiveWriteFailureRate: 0.2,
    })
  })

  it('filters runs by status, kind and search query', () => {
    const view = buildTraceViewModel(snapshot())

    expect(filterTraceRuns(view.runs, { level: 'running', type: 'all', search: '' }).map((run) => run.runId)).toEqual([
      'r2',
    ])
    expect(filterTraceRuns(view.runs, { level: 'all', type: 'tool', search: '' }).map((run) => run.runId)).toEqual([
      'r1',
    ])
    expect(filterTraceRuns(view.runs, { level: 'all', type: 'all', search: 'read_file' }).map((run) => run.runId)).toEqual([
      'r1',
    ])
  })

  it('filters timeline items without mutating the run', () => {
    const run = buildTraceViewModel(snapshot()).runs.find((item) => item.runId === 'r1')

    expect(filterTraceTimeline(run, { level: 'error', type: 'all', search: '' }).map((item) => item.id)).toEqual([
      'span:tool-1',
    ])
    expect(run?.timeline).toHaveLength(4)
  })

  it('builds the filtered view used by the trace viewer', () => {
    const view = buildTraceView(snapshot(), { level: 'all', type: 'event', search: 'checkpoint' })

    expect(view.totalRuns).toBe(2)
    expect(view.filteredRuns).toBe(1)
    expect(view.runs[0]?.runId).toBe('r1')
    expect(view.runs[0]?.timeline.map((entry) => entry.id)).toEqual(['event:event-1'])
  })

  it('highlights known anomaly reasons in run summary and timeline', () => {
    const view = buildTraceViewModel({
      source: 'sqlite',
      loadedAt: 1000,
      spans: [
        {
          id: 'root',
          traceId: 'trace-x',
          name: 'agent.turn',
          kind: 'agent',
          status: 'error',
          startedAt: 100,
          endedAt: 240,
          durationMs: 140,
          attrs: { sessionId: 's1', runId: 'rx', turnId: 'ux' },
        },
        {
          id: 'tool',
          traceId: 'trace-x',
          parentSpanId: 'root',
          name: 'tool.call',
          kind: 'tool',
          status: 'error',
          startedAt: 130,
          endedAt: 150,
          durationMs: 20,
          attrs: { sessionId: 's1', runId: 'rx', turnId: 'ux', toolName: 'shell', errorPreview: 'exit 1' },
          error: 'exit 1',
        },
      ],
      events: [
        {
          id: 'max',
          traceId: 'trace-x',
          spanId: 'root',
          name: 'agent.max_turns',
          timestamp: 200,
          attrs: { sessionId: 's1', runId: 'rx', turnId: 'ux', max_turns: 12, error: '超过最大工具轮数' },
        },
        {
          id: 'loop',
          traceId: 'trace-x',
          spanId: 'root',
          name: 'agent.loop_detected',
          timestamp: 210,
          attrs: { sessionId: 's1', runId: 'rx', turnId: 'ux', reason: 'same tool repeated' },
        },
        {
          id: 'validation',
          traceId: 'trace-x',
          spanId: 'root',
          name: 'tool.validation_failed',
          timestamp: 220,
          attrs: { sessionId: 's1', runId: 'rx', turnId: 'ux', validationError: 'missing command' },
        },
      ],
    })

    const run = view.runs[0]
    expect(run?.highlight?.reason).toBe('agent.loop_detected')
    expect(run?.highlightCount).toBe(4)
    expect(run?.errorCount).toBe(5)
    expect(run?.timeline.find((entry) => entry.name === 'tool.call')?.highlight?.reason).toBe('tool.call_error')
    expect(run?.timeline.find((entry) => entry.name === 'agent.max_turns')?.highlight?.reason).toBe('agent.max_turns')
    expect(run?.timeline.find((entry) => entry.name === 'agent.loop_detected')?.highlight?.detail).toBe('same tool repeated')
    expect(run?.timeline.find((entry) => entry.name === 'tool.validation_failed')?.highlight).toMatchObject({
      reason: 'tool.validation_failed',
      detail: 'missing command',
    })

    const filtered = filterTraceRuns(view.runs, { level: 'all', type: 'all', search: 'loop' })
    expect(filtered.map((item) => item.runId)).toEqual(['rx'])
  })
})
