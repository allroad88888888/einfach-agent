import { afterEach, describe, expect, it } from 'vitest'

import { configureObservability, flushObservability, resetObservability } from '../observability/trace'
import type { TraceDriver, TraceEvent, TraceSpan } from '../observability/types'
import type { ModelSettings } from '../state/core.type'
import { rootStore, sessionsAtom } from '../state/rootStore'
import { resetSessionStores } from '../state/sessionStore'
import { runSession } from './modelRun'

const SESSION_ID = 'model-turn-trace-correlation'
const SETTINGS: ModelSettings = { vendor: 'deepseek', model: 'm' }

function captureTrace(): { spans: TraceSpan[]; events: TraceEvent[]; driver: TraceDriver } {
  const spans: TraceSpan[] = []
  const events: TraceEvent[] = []
  return {
    spans,
    events,
    driver: {
      async writeSpan(span) {
        spans.push(JSON.parse(JSON.stringify(span)) as TraceSpan)
      },
      async writeEvent(event) {
        events.push(JSON.parse(JSON.stringify(event)) as TraceEvent)
      },
    },
  }
}

function createResponse(): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'done' } }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

afterEach(() => {
  resetObservability()
  resetSessionStores()
  rootStore.setter(sessionsAtom, (sessions) => {
    const { [SESSION_ID]: _removed, ...remaining } = sessions
    return remaining
  })
})

describe('model turn trace correlation', () => {
  it('links a context snapshot to its completed request by run and llm turn', async () => {
    const trace = captureTrace()
    configureObservability({ driver: trace.driver })
    rootStore.setter(sessionsAtom, (sessions) => ({
      ...sessions,
      [SESSION_ID]: {
        id: SESSION_ID,
        title: 'trace correlation',
        settings: SETTINGS,
        createdAt: 1,
        updatedAt: 1,
      },
    }))

    await runSession(SESSION_ID, 'hello', {
      apiKey: 'test-key',
      signal: new AbortController().signal,
      fetchImpl: async () => createResponse(),
    })
    await flushObservability()

    const snapshot = trace.events.find((event) => event.name === 'llm.context_snapshot')
    const request = trace.spans.find((span) => span.name === 'llm.chat' && span.status === 'ok')

    expect(snapshot?.attrs).toMatchObject({
      runId: expect.any(String),
      llm_turn: 1,
      dynamic_controls_count: 0,
      cache_projection_transition: 'initial',
      cache_projection_current_items: expect.any(Number),
      cache_assembly_raw_items: expect.any(Number),
      cache_assembly_control_plan_snapshot_items: 0,
      cache_assembly_control_plan_continuation_items: 0,
      cache_assembly_control_tool_failure_notice_items: 0,
      cache_assembly_segment_mismatch: false,
      cache_assembly_transform_changed: false,
      cache_assembly_prepare_changed: false,
    })
    expect(request?.attrs).toMatchObject({
      runId: snapshot?.attrs?.runId,
      llm_turn: snapshot?.attrs?.llm_turn,
      dynamic_controls_count: snapshot?.attrs?.dynamic_controls_count,
      cache_assembly_raw_fingerprint: snapshot?.attrs?.cache_assembly_raw_fingerprint,
      cache_assembly_final_fingerprint: snapshot?.attrs?.cache_assembly_final_fingerprint,
    })
  })
})
