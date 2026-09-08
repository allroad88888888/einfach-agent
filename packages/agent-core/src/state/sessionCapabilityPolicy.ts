export const SESSION_CAPABILITY_POLICY_VERSION = 1 as const

export type SessionCapabilityKind = 'tool' | 'skill'

export interface DraftSessionCapabilityPolicy {
  version: typeof SESSION_CAPABILITY_POLICY_VERSION
  state: 'draft'
  revision: number
  disabledTools: string[]
  disabledSkills: string[]
}

export interface LockedSessionCapabilityPolicy {
  version: typeof SESSION_CAPABILITY_POLICY_VERSION
  state: 'locked'
  revision: number
  allowedTools: string[]
  allowedSkills: string[]
  lockedAt: number
}

export type SessionCapabilityPolicy =
  | DraftSessionCapabilityPolicy
  | LockedSessionCapabilityPolicy

export interface SessionCapabilitySelection {
  kind: SessionCapabilityKind
  name: string
  available: boolean
  selected: boolean
}

export const SESSION_CAPABILITY_CONTROL_TOOLS: ReadonlySet<string> = new Set([
  'request_tool_schema',
  'skill_search',
  'skill_read',
])

function normalizedNames(names: readonly string[]): string[] {
  return Array.from(new Set(names.filter((name) => name.length > 0))).sort()
}

export function createLockedEmptySessionCapabilityPolicy(): LockedSessionCapabilityPolicy {
  return {
    version: SESSION_CAPABILITY_POLICY_VERSION,
    state: 'locked',
    revision: 0,
    allowedTools: [],
    allowedSkills: [],
    lockedAt: 0,
  }
}

export function createDraftSessionCapabilityPolicy(): DraftSessionCapabilityPolicy {
  return {
    version: SESSION_CAPABILITY_POLICY_VERSION,
    state: 'draft',
    revision: 0,
    disabledTools: [],
    disabledSkills: [],
  }
}

export function normalizeSessionCapabilityPolicy(
  policy: unknown,
): SessionCapabilityPolicy {
  if (!isSessionCapabilityPolicy(policy)) return createLockedEmptySessionCapabilityPolicy()
  if (policy.state === 'draft') {
    return {
      version: SESSION_CAPABILITY_POLICY_VERSION,
      state: 'draft',
      revision: policy.revision,
      disabledTools: normalizedNames(policy.disabledTools),
      disabledSkills: normalizedNames(policy.disabledSkills),
    }
  }
  return {
    version: SESSION_CAPABILITY_POLICY_VERSION,
    state: 'locked',
    revision: policy.revision,
    allowedTools: normalizedNames(policy.allowedTools),
    allowedSkills: normalizedNames(policy.allowedSkills),
    lockedAt: policy.lockedAt,
  }
}

export function isSessionCapabilityPolicy(value: unknown): value is SessionCapabilityPolicy {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  if (candidate.version !== SESSION_CAPABILITY_POLICY_VERSION
    || (candidate.state !== 'draft' && candidate.state !== 'locked')
    || !Number.isSafeInteger(candidate.revision) || Number(candidate.revision) < 0) return false
  const keys = Object.keys(candidate).sort()
  const expected = candidate.state === 'draft'
    ? ['disabledSkills', 'disabledTools', 'revision', 'state', 'version']
    : ['allowedSkills', 'allowedTools', 'lockedAt', 'revision', 'state', 'version']
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) return false
  if (candidate.state === 'draft') {
    return isCanonicalNames(candidate.disabledTools) && isCanonicalNames(candidate.disabledSkills)
  }
  return isCanonicalNames(candidate.allowedTools) && isCanonicalNames(candidate.allowedSkills)
    && Number.isSafeInteger(candidate.lockedAt) && Number(candidate.lockedAt) >= 0
}

function isCanonicalNames(value: unknown): value is string[] {
  if (!Array.isArray(value) || !value.every((name) => typeof name === 'string' && name.length > 0)) return false
  return value.every((name, index) => index === 0 || value[index - 1] < name)
}

export function sessionCapabilityPolicyVersion(policy: unknown): string {
  return policy === undefined ? 'legacy-unrestricted' : JSON.stringify(normalizeSessionCapabilityPolicy(policy))
}

export function toggleSessionCapability(
  policy: SessionCapabilityPolicy,
  kind: SessionCapabilityKind,
  name: string,
  selected: boolean,
): DraftSessionCapabilityPolicy {
  if (policy.state !== 'draft') throw new Error('Session capability policy is locked')
  const normalized = normalizeSessionCapabilityPolicy(policy) as DraftSessionCapabilityPolicy
  const key = kind === 'tool' ? 'disabledTools' : 'disabledSkills'
  const disabled = new Set(normalized[key])
  if (selected) disabled.delete(name)
  else disabled.add(name)
  return { ...normalized, revision: normalized.revision + 1, [key]: normalizedNames([...disabled]) }
}

export function lockSessionCapabilityPolicy(
  policy: SessionCapabilityPolicy,
  catalog: readonly SessionCapabilitySelection[],
  lockedAt: number,
): LockedSessionCapabilityPolicy {
  if (policy.state === 'locked') return normalizeSessionCapabilityPolicy(policy) as LockedSessionCapabilityPolicy
  const selected = (kind: SessionCapabilityKind) => normalizedNames(catalog
    .filter((item) => item.kind === kind && item.available && item.selected)
    .map((item) => item.name))
  return {
    version: SESSION_CAPABILITY_POLICY_VERSION,
    state: 'locked',
    revision: policy.revision + 1,
    allowedTools: selected('tool'),
    allowedSkills: selected('skill'),
    lockedAt,
  }
}

export function cloneSessionCapabilityPolicyAsDraft(
  policy: SessionCapabilityPolicy | undefined,
  catalog: readonly SessionCapabilitySelection[],
): DraftSessionCapabilityPolicy {
  if (policy === undefined) return createDraftSessionCapabilityPolicy()
  const disabled = (kind: SessionCapabilityKind) => normalizedNames(catalog
    .filter((item) => item.kind === kind && (!item.available || !item.selected))
    .map((item) => item.name))
  return {
    ...createDraftSessionCapabilityPolicy(),
    disabledTools: disabled('tool'),
    disabledSkills: disabled('skill'),
  }
}

export function isSessionCapabilityAllowed(
  policy: unknown,
  kind: SessionCapabilityKind,
  name: string,
): boolean {
  if (kind === 'tool' && SESSION_CAPABILITY_CONTROL_TOOLS.has(name)) return true
  if (policy === undefined) return true
  if (!isSessionCapabilityPolicy(policy)) return false
  const names = kind === 'tool'
    ? policy.state === 'draft' ? policy.disabledTools : policy.allowedTools
    : policy.state === 'draft' ? policy.disabledSkills : policy.allowedSkills
  return policy.state === 'draft' ? !names.includes(name) : names.includes(name)
}
