import { describe, expect, it } from 'vitest'
import { parseSubagentEvents, replaySubagentArchive } from './replay'

function event(type: string, eventId: string, agentPath: string) {
  return JSON.stringify({
    eventId,
    type,
    timestamp: '2026-07-09T01:00:00.000Z',
    conversationId: 'c1',
    runId: 'r1',
    treeId: 'r1',
    agentPath,
  })
}

describe('replay recognizes child model telemetry events', () => {
  const telemetryTypes = [
    'child_model_usage',
    'child_context_distillation_started',
    'child_context_distillation_succeeded',
    'child_context_distillation_failed',
  ] as const

  it('keeps usage and checkpoint events out of parse errors', () => {
    const text = telemetryTypes
      .map((type, index) => event(type, `ev-${index}`, 'root-01'))
      .join('\n')

    const result = parseSubagentEvents(text)

    expect(result.parseErrors).toHaveLength(0)
    expect(result.records.map((record) => record.type)).toEqual([...telemetryTypes])
  })

  it('counts every telemetry type and initializes absent types to zero', () => {
    const eventsText = [
      event('archive_initialized', 'ev-0', 'root'),
      ...telemetryTypes.map((type, index) => event(type, `ev-${index + 1}`, `root-0${index + 1}`)),
    ].join('\n')

    const state = replaySubagentArchive({ eventsText })

    expect(state.eventCounts.child_model_usage).toBe(1)
    expect(state.eventCounts.child_context_distillation_started).toBe(1)
    expect(state.eventCounts.child_context_distillation_succeeded).toBe(1)
    expect(state.eventCounts.child_context_distillation_failed).toBe(1)
    expect(state.eventCounts.child_finished).toBe(0)
  })
})
