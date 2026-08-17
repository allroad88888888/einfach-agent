import { createStore, type Store } from '@einfach/core'
import { describe, expect, it } from 'vitest'
import type { SessionMeta } from './core.type'
import { captureRecoverySnapshot } from './recoveryProjection'
import { sessionsAtom } from './rootAtoms'

function session(id: string): SessionMeta {
  return {
    id,
    title: `Session ${id}`,
    settings: {
      vendor: 'deepseek',
      model: 'deepseek-v4-pro',
      thinking: true,
      temperature: 0.3,
      max_tokens: 4_000,
      vendorSettings: { region: 'cn' },
    },
    createdAt: 10,
    updatedAt: 20,
    workspaceId: `workspace-${id}`,
    workspaceRoot: `/workspace/${id}`,
    toolApprovalMode: 'auto',
    loadedTools: ['read_file'],
  }
}

function rootStoreWith(...metas: SessionMeta[]): Store {
  const rootStore = createStore()
  rootStore.setter(sessionsAtom, Object.fromEntries(metas.map((meta) => [meta.id, meta])))
  return rootStore
}

function capture(rootStore: Store, sessionId: string) {
  return captureRecoverySnapshot(createStore(), { rootStore, sessionId, generation: 1, capturedAt: 30 })
}

describe('recoveryProjection static session capture', () => {
  it('uses the requested root registration and excludes session-store dynamic fields', () => {
    const firstStatic = session('session-first')
    const first = {
      ...firstStatic,
      plan: {}, executionGraph: {},
    } as SessionMeta
    const second = session('session-second')
    const rootStore = rootStoreWith(first, second)

    const firstSnapshot = capture(rootStore, first.id)
    const secondSnapshot = capture(rootStore, second.id)

    expect(firstSnapshot.session).toEqual(firstStatic)
    expect(secondSnapshot.session).toEqual(second)
    expect(firstSnapshot.session).not.toHaveProperty('plan')
    expect(firstSnapshot.session).not.toHaveProperty('executionGraph')
  })

  it('refuses a capture for a session absent from the authoritative root registration', () => {
    expect(() => capture(rootStoreWith(session('registered')), 'missing')).toThrow(
      'Cannot capture recovery for an unregistered session: missing',
    )
  })

  it('rejects function and cyclic root metadata before JSON cloning can lose data', () => {
    const functionSession = session('function')
    functionSession.settings.vendorSettings = { normalize: () => undefined }
    const cyclicSession = session('cycle')
    const vendorSettings: Record<string, unknown> = {}
    vendorSettings.self = vendorSettings
    cyclicSession.settings.vendorSettings = vendorSettings

    expect(() => capture(rootStoreWith(functionSession), functionSession.id)).toThrow(
      'Recovery projection does not satisfy RecoverySnapshotV1',
    )
    expect(() => capture(rootStoreWith(cyclicSession), cyclicSession.id)).toThrow(
      'Recovery projection does not satisfy RecoverySnapshotV1',
    )
  })
})
