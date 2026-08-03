import { afterEach, describe, expect, it } from 'vitest'
import { sessionsAtom } from '../state/rootStore'
import { itemsAtom, runAtom } from '../state/sessionAtoms'
import type { CoreInstance } from './core/coreInstance'
import { createCore } from './core/createCore'
import type { CorePlugin } from './core/pluginHost'
import { configureObservability, flushObservability, resetObservability } from '../observability/trace'
import type { TraceDriver, TraceEvent, TraceSpan } from '../observability/types'
import { resumeInterruptedSession, resumePlanSession, runSession } from './modelRun'

const marker = 'plugin-request-marker'

type RequestMode = 'fresh' | 'interrupted' | 'plan'

function seedSession(core: CoreInstance, id: string): void {
  core.rootStore.setter(sessionsAtom, {
    [id]: {
      id,
      title: 'prepare request',
      settings: { vendor: 'deepseek', model: 'x' },
      createdAt: 0,
      updatedAt: 0,
    },
  })
}

function modelResponse(content = 'ok'): Response {
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function requestMessages(body: Record<string, unknown>): Array<{ role?: unknown; content?: unknown }> {
  return Array.isArray(body.messages) ? body.messages as Array<{ role?: unknown; content?: unknown }> : []
}

function markerPlugin(onPrepare: () => void): CorePlugin {
  return {
    activate(api) {
      api.hook('prepareRequest', (_ctx, draft) => {
        onPrepare()
        draft.messages.push({ role: 'system', content: marker })
      })
    },
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

async function runMode(mode: RequestMode, core: CoreInstance, id: string, fetchImpl: typeof fetch): Promise<void> {
  const options = { signal: new AbortController().signal, apiKey: 'k', fetchImpl, core }
  if (mode === 'fresh') return runSession(id, 'new input', options)

  const store = core.getSessionStore(id).store
  store.setter(itemsAtom, [{ id: 'persisted-input', createdAt: 0, item: { role: 'user', content: 'persisted input' } }])
  if (mode === 'interrupted') {
    store.setter(runAtom, { runId: 'interrupted-run', status: 'interrupted', turnId: 'persisted-input' })
    return resumeInterruptedSession(id, options)
  }
  return resumePlanSession(id, options)
}

afterEach(() => resetObservability())

describe('prepareRequest production integration', () => {
  it('projects its marker into exactly one fresh, interrupted, and plan-resume request without mutating session items', async () => {
    for (const mode of ['fresh', 'interrupted', 'plan'] as const) {
      let prepares = 0
      let requests = 0
      let body: Record<string, unknown> | undefined
      const core = createCore({ plugins: [markerPlugin(() => { prepares += 1 })] })
      const id = `prepare-${mode}`
      seedSession(core, id)
      const fetchImpl: typeof fetch = async (_url, init) => {
        requests += 1
        body = JSON.parse(String(init?.body)) as Record<string, unknown>
        return modelResponse(`${mode} response`)
      }

      try {
        await runMode(mode, core, id, fetchImpl)

        expect(prepares).toBe(1)
        expect(requests).toBe(1)
        expect(requestMessages(body!).some((message) => message.content === marker)).toBe(true)
        expect(JSON.stringify(core.getSessionStore(id).store.getter(itemsAtom))).not.toContain(marker)
      } finally {
        core.plugins.dispose()
      }
    }
  })

  it('records the hook failure, marks the run as error, and does not issue a model request', async () => {
    const trace = captureTrace()
    configureObservability({ driver: trace.driver })
    const core = createCore({
      plugins: [{ activate: (api) => api.hook('prepareRequest', () => { throw new Error('prepare request failed') }) }],
    })
    const id = 'prepare-failure'
    seedSession(core, id)
    let requests = 0

    try {
      await runSession(id, 'input', {
        signal: new AbortController().signal,
        apiKey: 'k',
        core,
        fetchImpl: async () => {
          requests += 1
          return modelResponse()
        },
      })
      await flushObservability()

      expect(requests).toBe(0)
      expect(core.getSessionStore(id).store.getter(runAtom)).toMatchObject({ status: 'error', error: 'prepare request failed' })
      expect(trace.events.some((event) => event.name === 'agent.plugin_prepare_request_failed' && event.attrs?.error === 'prepare request failed')).toBe(true)
      expect(trace.events.some((event) => event.name === 'agent.error')).toBe(true)
    } finally {
      core.plugins.dispose()
    }
  })
})
