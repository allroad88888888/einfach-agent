import { afterEach, describe, expect, it } from 'vitest'
import { createCoreInstance } from './core/coreInstance'
import { buildToolContext } from './toolContext'
import { configureHostInvoke, type HostInvoke } from './hostBridge'
import { sessionsAtom } from '../state/rootStore'
import { setRun } from '../state/sessionWriters'
import { toolActivityAtom, removeToolActivity } from '../state/transientAtoms'

const core = createCoreInstance()
afterEach(() => configureHostInvoke(undefined))
function context(sessionId: string, callId: string, signal = new AbortController().signal) {
  core.rootStore.setter(sessionsAtom, (prev) => ({ ...prev,
    [sessionId]: { id: sessionId, title: '', createdAt: 0, updatedAt: 0, settings: { vendor: 'deepseek', model: 'x' } },
  }))
  setRun(sessionId, { runId: 'r', status: 'running' }, core)
  return buildToolContext({ sessionId, runId: 'r', callId, toolName: 'shell_macos', signal, core })
}

describe('shell output belongs to its context', () => {
  it('isolates sessions and call IDs, bounds its tail, ignores abort/stale/removal', async () => {
    const callbacks = new Map<string, NonNullable<NonNullable<Parameters<HostInvoke>[2]>['onShellOutput']>>()
    configureHostInvoke({ platform: 'macos', loader: async () => async <T>(_cmd: string, args?: Record<string, unknown>, options?: Parameters<HostInvoke>[2]) => {
      if (options?.onShellOutput) callbacks.set(String(args?.command), options.onShellOutput)
      return { exit_code: 0 } as T
    } })
    const controller = new AbortController()
    const a = context('a', 'same', controller.signal)
    const b = context('b', 'same')
    const c = context('a', 'different')
    await a.runShell({ platform: 'macos', command: 'a' })
    await b.runShell({ platform: 'macos', command: 'b' })
    await c.runShell({ platform: 'macos', command: 'c' })
    callbacks.get('a')!({ stream: 'stdout', text: 'private-a' })
    callbacks.get('b')!({ stream: 'stderr', text: 'private-b' })
    const activity = (id: string) => core.getSessionStore(id).store.getter(toolActivityAtom)
    expect(activity('a').map((entry) => entry.output)).toEqual(['private-a', undefined])
    expect(activity('b')[0].output).toBe('private-b')
    callbacks.get('c')!({ stream: 'stdout', text: 'x'.repeat(50_000) })
    expect(activity('a')[1].output).toHaveLength(20_000)
    expect(activity('a')[1].outputChars).toBe(50_000)
    callbacks.get('c')!({ stream: 'stdout', text: '😀' + 'x'.repeat(19_999) })
    expect(activity('a')[1].output).toBe('x'.repeat(19_999))
    controller.abort()
    callbacks.get('a')!({ stream: 'stdout', text: 'late' })
    expect(activity('a')[0].output).toBe('private-a')
    removeToolActivity('a', 'different', core)
    callbacks.get('c')!({ stream: 'stdout', text: 'late' })
    expect(activity('a')).toHaveLength(1)
    setRun('b', { runId: 'new', status: 'running' }, core)
    callbacks.get('b')!({ stream: 'stdout', text: 'stale' })
    expect(activity('b')[0].output).toBe('private-b')
  })
})
