import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionMeta, WorkspaceMeta } from '../state/core.type'
import type { SessionsPersistence } from '../state/persistence/contract'
import { sessionsAtom } from '../state/rootStore'
import { createCore } from './core/createCore'

function memorySessions(): SessionsPersistence & { readonly saved: readonly SessionMeta[] } {
  let saved: SessionMeta[] = []
  return {
    get saved() { return saved },
    async saveSessions(sessions) { saved = sessions.map((session) => structuredClone(session)) },
    async loadSessions() { return saved.map((session) => structuredClone(session)) },
    async saveWorkspaces(_workspaces: WorkspaceMeta[]) {},
    async loadWorkspaces() { return [] },
  }
}

describe('model settings persistence integration', () => {
  afterEach(() => vi.restoreAllMocks())

  it('round-trips the active session settings without changing its sibling', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(42)
    const persistence = memorySessions()
    const origin = createCore()
    origin.persistence.configure({ sessions: persistence })
    const activeId = origin.newSession({
      title: 'active',
      settings: { vendor: 'deepseek', model: 'deepseek-v4-pro' },
    })
    const siblingId = origin.newSession({
      title: 'sibling',
      settings: { vendor: 'kimi', model: 'kimi-k2.6', thinking: false },
    })
    origin.selectSession(activeId)

    const nextSettings = {
      vendor: 'glm',
      model: 'glm-5.2',
      thinking: true,
      temperature: 0.25,
      vendorSettings: {
        reasoning_effort: 'xhigh',
        connectionId: 'opaque-identity',
        opaque: { keep: true },
      },
    } as const
    expect(origin.setActiveSessionModelSettings(nextSettings)).toBe('updated')
    await vi.waitFor(() => expect(persistence.saved).toHaveLength(2))

    const revived = createCore()
    revived.persistence.configure({ sessions: persistence })
    expect(await revived.persistence.hydrate()).toBe(true)
    expect(revived.rootStore.getter(sessionsAtom)[activeId]?.settings)
      .toEqual(nextSettings)
    expect(revived.rootStore.getter(sessionsAtom)[siblingId]?.settings)
      .toEqual({ vendor: 'kimi', model: 'kimi-k2.6', thinking: false })
  })
})
