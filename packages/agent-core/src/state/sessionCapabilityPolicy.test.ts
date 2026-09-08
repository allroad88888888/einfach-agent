import { describe, expect, it } from 'vitest'
import {
  cloneSessionCapabilityPolicyAsDraft,
  createDraftSessionCapabilityPolicy,
  createLockedEmptySessionCapabilityPolicy,
  isSessionCapabilityAllowed,
  isSessionCapabilityPolicy,
  lockSessionCapabilityPolicy,
  normalizeSessionCapabilityPolicy,
  sessionCapabilityPolicyVersion,
  toggleSessionCapability,
  type LockedSessionCapabilityPolicy,
  type SessionCapabilitySelection,
} from './sessionCapabilityPolicy'
import { captureRunCapabilitySnapshot } from '../runtime/turnToolVisibility'

const catalog: SessionCapabilitySelection[] = [
  { kind: 'tool', name: 'z_tool', available: true, selected: true },
  { kind: 'tool', name: 'a_tool', available: true, selected: false },
  { kind: 'tool', name: 'gone_tool', available: false, selected: true },
  { kind: 'skill', name: 'writing', available: true, selected: true },
  { kind: 'skill', name: 'disabled', available: true, selected: false },
]

describe('session capability policy', () => {
  it('creates a v1 default-all draft that only records deselection', () => {
    const draft = createDraftSessionCapabilityPolicy()

    expect(draft).toEqual({
      version: 1,
      state: 'draft',
      revision: 0,
      disabledTools: [],
      disabledSkills: [],
    })
    expect(isSessionCapabilityAllowed(draft, 'tool', 'new_tool')).toBe(true)
  })

  it('toggles draft entries without mutating input and rejects locked writes', () => {
    const draft = createDraftSessionCapabilityPolicy()
    const disabled = toggleSessionCapability(draft, 'tool', 'shell', false)
    const enabled = toggleSessionCapability(disabled, 'tool', 'shell', true)

    expect(draft.disabledTools).toEqual([])
    expect(disabled).toMatchObject({ revision: 1, disabledTools: ['shell'] })
    expect(enabled).toMatchObject({ revision: 2, disabledTools: [] })
    expect(() => toggleSessionCapability(
      lockSessionCapabilityPolicy(draft, catalog, 10),
      'tool',
      'a_tool',
      true,
    )).toThrow('locked')
  })

  it('fails closed instead of normalizing a non-canonical persisted shape', () => {
    expect(normalizeSessionCapabilityPolicy({
      version: 1,
      state: 'draft',
      revision: 4,
      disabledTools: ['z', 'a', 'z'],
      disabledSkills: ['b', 'a', 'b'],
    })).toEqual(createLockedEmptySessionCapabilityPolicy())
  })

  it('locks only currently available selections and preserves a locked policy unchanged', () => {
    const draft = createDraftSessionCapabilityPolicy()
    const locked = lockSessionCapabilityPolicy(draft, catalog, 20)

    expect(locked).toEqual({
      version: 1,
      state: 'locked',
      revision: 1,
      allowedTools: ['z_tool'],
      allowedSkills: ['writing'],
      lockedAt: 20,
    })
    expect(lockSessionCapabilityPolicy(locked, [], 99)).toEqual(locked)
    expect(isSessionCapabilityAllowed(locked, 'tool', 'gone_tool')).toBe(false)
  })

  it('always allows protocol control tools independently of policy and loadedTools', () => {
    const locked = lockSessionCapabilityPolicy(createDraftSessionCapabilityPolicy(), [], 30)

    expect(isSessionCapabilityAllowed(locked, 'tool', 'request_tool_schema')).toBe(true)
    expect(isSessionCapabilityAllowed(locked, 'tool', 'skill_search')).toBe(true)
    expect(isSessionCapabilityAllowed(locked, 'tool', 'skill_read')).toBe(true)
    expect(isSessionCapabilityAllowed(locked, 'tool', 'ordinary')).toBe(false)
  })

  it('clones a locked selection into a draft over only current available entries', () => {
    const locked: LockedSessionCapabilityPolicy = {
      version: 1,
      state: 'locked',
      revision: 5,
      allowedTools: ['gone_tool', 'z_tool'],
      allowedSkills: ['writing'],
      lockedAt: 30,
    }

    expect(cloneSessionCapabilityPolicyAsDraft(locked, catalog)).toEqual({
      version: 1,
      state: 'draft',
      revision: 0,
      disabledTools: ['a_tool', 'gone_tool'],
      disabledSkills: ['disabled'],
    })
    expect(cloneSessionCapabilityPolicyAsDraft(undefined, catalog))
      .toEqual(createDraftSessionCapabilityPolicy())
  })

  it('strictly validates canonical persisted shapes while accepting no policy at SessionMeta level', () => {
    expect(isSessionCapabilityPolicy(createDraftSessionCapabilityPolicy())).toBe(true)
    expect(isSessionCapabilityPolicy({
      ...createDraftSessionCapabilityPolicy(),
      disabledTools: ['z', 'a'],
    })).toBe(false)
    expect(isSessionCapabilityPolicy({
      ...createDraftSessionCapabilityPolicy(),
      unknown: true,
    })).toBe(false)
  })

  it.each([
    null,
    { version: 2, state: 'locked', revision: 1, allowedTools: ['secret'], allowedSkills: ['hidden'], lockedAt: 1 },
    { version: 1, state: 'locked', revision: 1, allowedTools: ['secret'], allowedSkills: ['hidden'], lockedAt: 1, extra: true },
    { version: 1, state: 'locked', revision: 1, allowedTools: ['z', 'a'], allowedSkills: [], lockedAt: 1 },
  ])('makes malformed runtime policy deny business tools and skills: %j', (policy) => {
    expect(sessionCapabilityPolicyVersion(policy)).toBe(JSON.stringify(createLockedEmptySessionCapabilityPolicy()))
    expect(isSessionCapabilityAllowed(policy, 'tool', 'secret')).toBe(false)
    expect(isSessionCapabilityAllowed(policy, 'skill', 'hidden')).toBe(false)

    const snapshot = captureRunCapabilitySnapshot(policy)
    expect(snapshot.state).toBe('locked')
    expect(snapshot.allowsTool('secret')).toBe(false)
    expect(snapshot.allowsSkill('hidden')).toBe(false)
    expect(snapshot.allowsTool('skill_read')).toBe(true)
  })
})
