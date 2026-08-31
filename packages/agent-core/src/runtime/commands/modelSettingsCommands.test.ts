import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activeSessionIdAtom, sessionsAtom } from '../../state/rootStore'
import { runAtom } from '../../state/sessionAtoms'
import type { ModelSettings, RunStatus, SessionMeta } from '../../state/core.type'
import { createCoreInstance, type CoreInstance } from '../core/coreInstance'
import { createCommands } from '../commands'
import { createModelSettingsCommands } from './modelSettingsCommands'

const firstSettings: ModelSettings = {
  vendor: 'openai-compat',
  model: 'first-model',
  thinking: true,
  vendorSettings: {
    connectionId: 'connection-first',
    reasoning_effort: 'high',
    nested: { keep: true },
  },
}

function session(id: string, settings: ModelSettings, updatedAt = 10): SessionMeta {
  return { id, title: id, settings, createdAt: 1, updatedAt }
}

let core: CoreInstance
let commands: ReturnType<typeof createModelSettingsCommands>
let persistSessions: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  core = createCoreInstance()
  commands = createModelSettingsCommands(core)
  persistSessions = vi.spyOn(core.persistence, 'persistSessions')
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('modelSettingsCommands', () => {
  it('atomically replaces only the active session settings and persists the complete opaque bag', () => {
    const sibling = session('second', { vendor: 'glm', model: 'glm-5.3' }, 20)
    const next: ModelSettings = {
      vendor: 'openai-compat',
      model: 'next-model',
      thinking: true,
      vendorSettings: {
        connectionId: 'connection-next',
        reasoning_effort: 'xhigh',
        nested: { keep: 'all opaque values' },
      },
    }
    core.rootStore.setter(sessionsAtom, { first: session('first', firstSettings), second: sibling })
    core.rootStore.setter(activeSessionIdAtom, 'first')
    vi.spyOn(Date, 'now').mockReturnValue(99)

    expect(commands.setActiveSessionModelSettings(next)).toBe('updated')
    expect(core.rootStore.getter(sessionsAtom).first).toEqual({
      ...session('first', firstSettings), settings: next, updatedAt: 99,
    })
    expect(core.rootStore.getter(sessionsAtom).second).toBe(sibling)
    expect(persistSessions).toHaveBeenCalledOnce()
  })

  it('does not write an equivalent settings object or update its timestamp', () => {
    const existing = session('first', firstSettings)
    core.rootStore.setter(sessionsAtom, { first: existing })
    core.rootStore.setter(activeSessionIdAtom, 'first')

    const sameValues: ModelSettings = {
      model: 'first-model',
      vendor: 'openai-compat',
      thinking: true,
      vendorSettings: {
        nested: { keep: true },
        reasoning_effort: 'high',
        connectionId: 'connection-first',
      },
    }

    expect(commands.setActiveSessionModelSettings(sameValues)).toBe('unchanged')
    expect(core.rootStore.getter(sessionsAtom).first).toBe(existing)
    expect(persistSessions).not.toHaveBeenCalled()
  })

  it('rejects a missing active session without persisting', () => {
    core.rootStore.setter(activeSessionIdAtom, 'missing')

    expect(commands.setActiveSessionModelSettings(firstSettings)).toBe('missing')
    expect(persistSessions).not.toHaveBeenCalled()
  })

  it('rejects every running, waiting, and recovery status without changing settings', () => {
    const busyStatuses: RunStatus[] = [
      'running',
      'awaiting_tool',
      'waiting_user',
      'waiting_confirmation',
      'waiting_plan_approval',
      'interrupted',
    ]
    const existing = session('first', firstSettings)
    core.rootStore.setter(sessionsAtom, { first: existing })
    core.rootStore.setter(activeSessionIdAtom, 'first')

    for (const status of busyStatuses) {
      core.getSessionStore('first').store.setter(runAtom, { runId: `run-${status}`, status })
      expect(commands.setActiveSessionModelSettings({ vendor: 'glm', model: 'glm-5.3' })).toBe('busy')
    }

    expect(core.rootStore.getter(sessionsAtom).first).toBe(existing)
    expect(persistSessions).not.toHaveBeenCalled()
  })

  it('adds the command to a CoreInstance-bound command facade', () => {
    const facade = createCommands(core)
    core.rootStore.setter(sessionsAtom, { first: session('first', firstSettings) })
    core.rootStore.setter(activeSessionIdAtom, 'first')

    expect(facade.setActiveSessionModelSettings({ vendor: 'glm', model: 'glm-5.3' })).toBe('updated')
    expect(persistSessions).toHaveBeenCalledOnce()
  })
})
