import { describe, expect, it } from 'vitest'
import { itemsAtom, runAtom } from '../state/sessionAtoms'
import { createCore } from './core/createCore'
import { unresolvedToolCalls } from './toolCallOutcomeFacts'

function assistantCall(id: string, callId: string) {
  return {
    id,
    createdAt: 1,
    item: {
      role: 'assistant' as const,
      content: null,
      tool_calls: [{ id: callId, type: 'function' as const, function: { name: 'write_file', arguments: '{}' } }],
    },
  }
}

function userItem(id: string) {
  return { id, createdAt: 1, item: { role: 'user' as const, content: id } }
}

describe('unresolvedToolCalls', () => {
  it('only identifies unpaired calls after a present turn anchor', () => {
    const core = createCore()
    const sessionId = core.newSession()
    const store = core.getSessionStore(sessionId).store
    store.setter(itemsAtom, [assistantCall('stale-call', 'stale'), userItem('turn-anchor'), assistantCall('current-call', 'current')])
    store.setter(runAtom, { runId: 'run-1', status: 'interrupted', turnId: 'turn-anchor' })

    expect(unresolvedToolCalls(sessionId, core).map((call) => call.callId)).toEqual(['current'])
  })

  it('falls back to the latest user item when the turn anchor is missing', () => {
    const core = createCore()
    const sessionId = core.newSession()
    const store = core.getSessionStore(sessionId).store
    store.setter(itemsAtom, [assistantCall('stale-call', 'stale'), userItem('fallback-user')])
    store.setter(runAtom, { runId: 'run-1', status: 'interrupted', turnId: 'missing-anchor' })

    expect(unresolvedToolCalls(sessionId, core)).toEqual([])
  })

  it('starts from the transcript beginning when no user item exists', () => {
    const core = createCore()
    const sessionId = core.newSession()
    const store = core.getSessionStore(sessionId).store
    store.setter(itemsAtom, [assistantCall('unanchored-call', 'unanchored')])
    store.setter(runAtom, { runId: 'run-1', status: 'interrupted' })

    expect(unresolvedToolCalls(sessionId, core).map((call) => call.callId)).toEqual(['unanchored'])
  })
})
