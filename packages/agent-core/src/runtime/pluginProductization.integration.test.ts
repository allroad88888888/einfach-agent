import { afterEach, describe, expect, it } from 'vitest'
import { activeSessionIdAtom, sessionsAtom } from '../state/rootStore'
import { itemsAtom, runAtom } from '../state/sessionAtoms'
import { configureObservability, flushObservability, resetObservability } from '../observability/trace'
import type { TraceDriver, TraceEvent, TraceSpan } from '../observability/types'
import {
  createLifecycleProbePlugin,
  LIFECYCLE_PROBE_TOOL_NAME,
} from '../../../agent-plugin-example/src'
import { createCore } from './core/createCore'
import type { CoreInstance } from './core/coreInstance'
import { createPluginHost } from './core/pluginHost'
import { createToolRegistry } from '../tools/toolRegistry'
import type { Tool } from '../tools/types'
import { runSession } from './modelRun'

function seedSession(core: CoreInstance, id: string, loadedTools: string[] = []): void {
  core.rootStore.setter(sessionsAtom, {
    [id]: {
      id,
      title: 'public plugin test',
      settings: { vendor: 'deepseek', model: 'x' },
      createdAt: 0,
      updatedAt: 0,
      loadedTools,
    },
  })
  core.rootStore.setter(activeSessionIdAtom, id)
}

function toolCallResponse(name: string, id: string): Response {
  return new Response(JSON.stringify({
    choices: [{
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id,
          type: 'function',
          function: { name, arguments: '{}' },
        }],
      },
    }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function textResponse(content: string): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { role: 'assistant', content } }],
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
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

function conflictingTool(): Tool {
  return {
    name: LIFECYCLE_PROBE_TOOL_NAME,
    runtime: 'internal',
    skill: { description: 'conflict', content: 'conflict' },
    inputSchema: { type: 'object', properties: {} },
    execute: async () => ({ ok: true }),
  }
}

afterEach(() => resetObservability())

describe('public plugin productization integration', () => {
  it('stops only its active run through the scoped command facade and releases every run subscription', async () => {
    const observed: string[] = []
    const disposed = { count: 0 }
    const plugin = createLifecycleProbePlugin({
      stopOnRunStart: true,
      onRunEvent: (run) => { if (run) observed.push(run.status) },
      onDispose: () => { disposed.count += 1 },
    })
    const core = createCore({ plugins: [plugin] })
    const id = 'public-stop'
    seedSession(core, id)
    let requests = 0

    try {
      expect(core.tools.has(LIFECYCLE_PROBE_TOOL_NAME)).toBe(true)
      await runSession(id, 'stop safely', {
        signal: new AbortController().signal,
        apiKey: 'k',
        core,
        fetchImpl: async () => {
          requests += 1
          return textResponse('should not be requested')
        },
      })

      expect(requests).toBe(0)
      expect(observed).toContain('running')
      expect(core.getSessionStore(id).store.getter(runAtom)?.status).toBe('stopped')
      expect(disposed.count).toBe(1)

      const countAfterRun = observed.length
      core.getSessionStore(id).store.setter(runAtom, { runId: 'later', status: 'running' })
      expect(observed).toHaveLength(countAfterRun)
    } finally {
      core.plugins.dispose()
    }

    expect(core.tools.has(LIFECYCLE_PROBE_TOOL_NAME)).toBe(false)
    expect(disposed.count).toBe(1)
  })

  it('isolates an external plugin after-tool exception without breaking its host run', async () => {
    const trace = captureTrace()
    configureObservability({ driver: trace.driver })
    const core = createCore({ plugins: [createLifecycleProbePlugin({ throwAfterToolCall: true })] })
    const id = 'public-after-tool'
    seedSession(core, id, [LIFECYCLE_PROBE_TOOL_NAME])
    let requests = 0

    try {
      await runSession(id, 'run the probe', {
        signal: new AbortController().signal,
        apiKey: 'k',
        core,
        fetchImpl: async () => {
          requests += 1
          return requests === 1
            ? toolCallResponse(LIFECYCLE_PROBE_TOOL_NAME, 'probe-call')
            : textResponse('completed after plugin error')
        },
      })
      await flushObservability()

      expect(requests).toBe(2)
      expect(core.getSessionStore(id).store.getter(runAtom)?.status).toBe('done')
      expect(core.getSessionStore(id).store.getter(itemsAtom)).toEqual(expect.arrayContaining([
        expect.objectContaining({ item: expect.objectContaining({ role: 'tool', tool_call_id: 'probe-call' }) }),
      ]))
      expect(trace.events.some((event) => event.name === 'agent.plugin_after_tool_call_failed')).toBe(true)
    } finally {
      core.plugins.dispose()
    }
  })

  it('rejects the sample tool conflict atomically and keeps plugin tools Core-scoped', () => {
    const registry = createToolRegistry()
    registry.register(conflictingTool())

    expect(() => createPluginHost(registry, [createLifecycleProbePlugin()]))
      .toThrow(`plugin tool name conflict: ${LIFECYCLE_PROBE_TOOL_NAME}`)
    expect(registry.has(LIFECYCLE_PROBE_TOOL_NAME)).toBe(true)

    const a = createCore({ plugins: [createLifecycleProbePlugin()] })
    const b = createCore()
    try {
      expect(a.tools.has(LIFECYCLE_PROBE_TOOL_NAME)).toBe(true)
      expect(b.tools.has(LIFECYCLE_PROBE_TOOL_NAME)).toBe(false)
    } finally {
      a.plugins.dispose()
      b.plugins.dispose()
    }
    expect(a.tools.has(LIFECYCLE_PROBE_TOOL_NAME)).toBe(false)
  })
})
