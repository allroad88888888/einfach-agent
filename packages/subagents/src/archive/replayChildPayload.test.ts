import { describe, expect, it } from 'vitest'
import { createChildStartedArchivePayload } from '@einfach-agent/core/subagents'
import { replaySubagentArchive } from './replay'

function event(type: string, eventId: string, agentPath: string, data?: Record<string, unknown>) {
  return JSON.stringify({
    eventId, type, agentPath, data,
    timestamp: '2026-07-09T01:00:00.000Z', conversationId: 'c1', runId: 'r1', treeId: 'r1',
  })
}

describe('replay child payload boundary', () => {
  it('rejects unsupported and malformed v1 terminal payloads without fabricating success', () => {
    const unsupported = replaySubagentArchive({
      eventsText: [
        event('archive_initialized', 'ev-01', 'root'),
        event('child_finished', 'ev-02', 'root-01', { child_payload_version: 2, status: 'failed' }),
      ].join('\n'),
    })
    const malformed = replaySubagentArchive({
      eventsText: [
        event('archive_initialized', 'ev-01', 'root'),
        event('child_finished', 'ev-02', 'root-01', {
          child_payload_version: 1, status: 'done', objective: 'write', summary: 'done',
          skillFiles: [], skillIds: [], changeSets: [{ id: 'change-01', reversible: 'yes' }],
        }),
      ].join('\n'),
    })

    expect(unsupported.childResults).toEqual([])
    expect(unsupported.nodes).not.toHaveProperty('root-01')
    expect(unsupported.parseErrors).toEqual([expect.objectContaining({ error: 'unsupported child_finished payload version 2' })])
    expect(malformed.childResults).toEqual([])
    expect(malformed.nodes).not.toHaveProperty('root-01')
    expect(malformed.parseErrors).toEqual([expect.objectContaining({ error: 'invalid v1 child_finished payload' })])
  })

  it('uses finished, then explicit snapshot, then started objective metadata', () => {
    const started = (eventId: string, path: string, objective: string) => event(
      'child_started', eventId, path, createChildStartedArchivePayload({ objective }),
    )
    const eventsText = [
      event('archive_initialized', 'ev-01', 'root'),
      started('ev-02', 'root-01', 'started must not replace snapshot'),
      event('child_finished', 'ev-03', 'root-01', { status: 'done', summary: 'snapshot wins' }),
      started('ev-04', 'root-02', 'started fills missing snapshot'),
      event('child_finished', 'ev-05', 'root-02', { status: 'done', summary: 'started fills' }),
      started('ev-06', 'root-03', 'started must not replace finished'),
      event('child_finished', 'ev-07', 'root-03', { status: 'done', objective: 'finished wins', summary: 'finished' }),
    ].join('\n')
    const treeText = JSON.stringify({ nodes: [
      { path: 'root-01', objective: 'snapshot wins' },
      { path: 'root-02' },
      { path: 'root-03', objective: 'snapshot loses to finished' },
    ] })

    const result = replaySubagentArchive({ eventsText, treeText })

    expect(result.childResults.map((child) => child.objective)).toEqual([
      'snapshot wins', 'started fills missing snapshot', 'finished wins',
    ])
  })
})
