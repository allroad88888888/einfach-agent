import { describe, expect, it } from 'vitest'
import type { SessionMeta } from './core.type'
import { createLockedEmptySessionCapabilityPolicy } from './sessionCapabilityPolicy'
import { sanitizeSessionCapabilityPolicy } from './sessionCapabilityHydration'

function session(capabilityPolicy?: unknown): SessionMeta {
  return {
    id: 'session',
    title: 'Session',
    settings: { vendor: 'deepseek', model: 'test' },
    createdAt: 1,
    updatedAt: 2,
    ...(arguments.length === 0 ? {} : { capabilityPolicy }),
  } as SessionMeta
}

const valid = {
  version: 1 as const,
  state: 'locked' as const,
  revision: 3,
  allowedTools: ['read_file'],
  allowedSkills: ['planning'],
  lockedAt: 4,
}

describe('sanitizeSessionCapabilityPolicy', () => {
  it('preserves a legal v1 policy and a missing legacy field unchanged', () => {
    const current = session(valid)
    const legacy = session()

    expect(sanitizeSessionCapabilityPolicy(current)).toBe(current)
    expect(sanitizeSessionCapabilityPolicy(legacy)).toBe(legacy)
    expect(sanitizeSessionCapabilityPolicy(legacy)).not.toHaveProperty('capabilityPolicy')
  })

  it.each([
    null,
    undefined,
    { ...valid, version: 2 },
    { ...valid, extra: true },
    { version: 1, state: 'locked', revision: 1, allowedTools: [], lockedAt: 1 },
    { ...valid, allowedTools: ['z', 'a'] },
    { ...valid, allowedSkills: [''] },
    { ...valid, lockedAt: -1 },
  ])('replaces a present malformed policy with locked-empty: %j', (policy) => {
    expect(sanitizeSessionCapabilityPolicy(session(policy)).capabilityPolicy)
      .toEqual(createLockedEmptySessionCapabilityPolicy())
  })
})
