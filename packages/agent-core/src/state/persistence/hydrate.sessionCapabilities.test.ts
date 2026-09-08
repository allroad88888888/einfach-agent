import { createStore } from '@einfach/core'
import { beforeEach, describe, expect, it } from 'vitest'
import type { SessionMeta } from '../core.type'
import { captureRecoverySnapshot } from '../recoveryProjection'
import { rootStore, resetRootStore, sessionsAtom } from '../rootStore'
import { resetSessionStores } from '../sessionStore'
import { createLockedEmptySessionCapabilityPolicy } from '../sessionCapabilityPolicy'
import type { RecoveryDriver } from './recoveryDriver'
import { hydrate } from './hydrate'

const validPolicy = {
  version: 1 as const,
  state: 'locked' as const,
  revision: 2,
  allowedTools: ['read_file'],
  allowedSkills: ['planning'],
  lockedAt: 3,
}

function session(id: string, capability: 'missing' | unknown): SessionMeta {
  return {
    id,
    title: id,
    settings: { vendor: 'deepseek', model: 'test' },
    createdAt: 1,
    updatedAt: 2,
    ...(capability === 'missing' ? {} : { capabilityPolicy: capability }),
  } as SessionMeta
}

function recoveryWith(snapshot: ReturnType<typeof captureRecoverySnapshot>): RecoveryDriver {
  return {
    async listLatest() { return [] },
    async loadLatest() { return snapshot },
    async saveLatest(_sessionId, value) { return { status: 'saved', generation: value.generation } },
    async deleteSession() {},
  }
}

beforeEach(() => {
  resetRootStore()
  resetSessionStores()
})

describe('hydrate session capability policy', () => {
  it('keeps legacy missing and valid v1, but converts every present invalid shape to locked-empty', async () => {
    const persisted = [
      session('legacy', 'missing'),
      session('valid', validPolicy),
      session('null', null),
      session('undefined', undefined),
      session('future', { ...validPolicy, version: 2 }),
      session('extra', { ...validPolicy, extra: true }),
      session('shape', { version: 1, state: 'locked', revision: 1, allowedTools: [], lockedAt: 1 }),
      session('names', { ...validPolicy, allowedTools: ['z', 'a'] }),
    ]

    await expect(hydrate({ sessions: { async loadSessions() { return persisted } } }))
      .resolves.toBe(true)

    const hydrated = rootStore.getter(sessionsAtom)
    expect(hydrated.legacy).not.toHaveProperty('capabilityPolicy')
    expect(hydrated.valid.capabilityPolicy).toEqual(validPolicy)
    for (const id of ['null', 'undefined', 'future', 'extra', 'shape', 'names']) {
      expect(hydrated[id].capabilityPolicy).toEqual(createLockedEmptySessionCapabilityPolicy())
    }
  })

  it('keeps a valid recovery static policy authoritative over a bad sessions-only copy', async () => {
    const recovered = session('recovery', validPolicy)
    const recoveryRoot = createStore()
    recoveryRoot.setter(sessionsAtom, { recovery: recovered })
    const snapshot = captureRecoverySnapshot(createStore(), {
      rootStore: recoveryRoot,
      sessionId: 'recovery',
      generation: 1,
      capturedAt: 4,
    })

    await expect(hydrate({
      sessions: { async loadSessions() { return [session('recovery', { ...validPolicy, version: 2 })] } },
      recovery: recoveryWith(snapshot),
    })).resolves.toBe(true)

    expect(rootStore.getter(sessionsAtom).recovery.capabilityPolicy).toEqual(validPolicy)
  })
})
