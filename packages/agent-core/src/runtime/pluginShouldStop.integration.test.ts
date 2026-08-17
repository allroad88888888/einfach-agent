import { afterEach, describe, expect, it, vi } from 'vitest'
import { activeSessionIdAtom, sessionsAtom } from '../state/rootStore'
import { runAtom } from '../state/sessionAtoms'
import { configureObservability, flushObservability, resetObservability } from '../observability/trace'
import type { TraceDriver, TraceEvent, TraceSpan } from '../observability/types'
import type { Tool } from '../tools/types'
import { createCore } from './core/createCore'
import type { CoreInstance } from './core/coreInstance'
import type { ShouldStopDecision } from './core/loopHooks'
import type { CorePlugin } from './core/pluginHost'
import { runSession } from './modelRun'

const stopDecision: ShouldStopDecision = {
  stop: true,
  runStatus: 'stopped',
  reason: 'plugin requested stop',
  checkpoint: { kind: 'stopped' },
}

function seedSession(core: CoreInstance, id: string, toolName: string): void {
  core.rootStore.setter(sessionsAtom, {
    [id]: {
      id,
      title: 'should stop test',
      settings: { vendor: 'deepseek', model: 'x' },
      createdAt: 0,
      updatedAt: 0,
      loadedTools: [toolName],
    },
  })
  core.rootStore.setter(activeSessionIdAtom, id)
}

function toolCallResponse(name: string): Response {
  return new Response(JSON.stringify({
    choices: [{
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'stop-call',
          type: 'function',
          function: { name, arguments: '{}' },
        }],
      },
    }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function testTool(name: string, execute: Tool['execute']): Tool {
  return {
    name,
    runtime: 'internal',
    skill: { description: name, content: name },
    inputSchema: { type: 'object', properties: {} },
    execute,
  }
}

function captureTrace(): { events: TraceEvent[]; driver: TraceDriver } {
  const events: TraceEvent[] = []
  return {
    events,
    driver: {
      async writeSpan(_span: TraceSpan) {},
      async writeEvent(event: TraceEvent) { events.push(event) },
    },
  }
}

afterEach(() => resetObservability())

describe('shouldStop production integration', () => {
  it('stops before a loaded tool can execute and commits the declared stopped checkpoint', async () => {
    const trace = captureTrace()
    configureObservability({ driver: trace.driver })
    const name = '__should_stop_tool__'
    const execute = vi.fn(() => ({ ok: true as const, data: 'must not execute' }))
    const plugin: CorePlugin = {
      activate: (api) => api.hook('shouldStop', () => stopDecision),
    }
    const core = createCore({
      plugins: [plugin],
      registerTools: (registry) => registry.register(testTool(name, execute)),
    })
    const id = 'should-stop'
    seedSession(core, id, name)

    try {
      await runSession(id, 'stop before tool', {
        signal: new AbortController().signal,
        apiKey: 'k',
        core,
        fetchImpl: async () => toolCallResponse(name),
      })
      await flushObservability()

      const store = core.getSessionStore(id).store
      expect(execute).not.toHaveBeenCalled()
      expect(store.getter(runAtom)).toMatchObject({ status: 'stopped', error: stopDecision.reason })
      expect(trace.events.some((event) => event.name === 'agent.plugin_should_stop')).toBe(true)
    } finally {
      core.plugins.dispose()
    }
  })

  it('turns a legacy boolean result into a traceable run error instead of guessing stop semantics', async () => {
    const trace = captureTrace()
    configureObservability({ driver: trace.driver })
    const name = '__invalid_should_stop_tool__'
    const execute = vi.fn(() => ({ ok: true as const }))
    const plugin: CorePlugin = {
      activate: (api) => api.hook('shouldStop', () => true as unknown as ShouldStopDecision),
    }
    const core = createCore({
      plugins: [plugin],
      registerTools: (registry) => registry.register(testTool(name, execute)),
    })
    const id = 'invalid-should-stop'
    seedSession(core, id, name)

    try {
      await runSession(id, 'reject boolean', {
        signal: new AbortController().signal,
        apiKey: 'k',
        core,
        fetchImpl: async () => toolCallResponse(name),
      })
      await flushObservability()

      const store = core.getSessionStore(id).store
      expect(execute).not.toHaveBeenCalled()
      expect(store.getter(runAtom)).toMatchObject({
        status: 'error',
        error: 'Invalid shouldStop decision: boolean results are not supported',
      })
      expect(trace.events.some((event) => event.name === 'agent.plugin_should_stop_failed')).toBe(true)
    } finally {
      core.plugins.dispose()
    }
  })
})
