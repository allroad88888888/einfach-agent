import { activeSessionIdAtom, sessionsAtom } from '../../state/rootAtoms'
import { projectStaticSessionMeta } from '../../state/sessionMetaProjection'
import {
  cloneSessionCapabilityPolicyAsDraft,
  lockSessionCapabilityPolicy,
  sessionCapabilityPolicyVersion,
  toggleSessionCapability,
  type SessionCapabilityKind,
  type SessionCapabilityPolicy,
} from '../../state/sessionCapabilityPolicy'
import type { ModelSettings } from '../../state/core.type'
import type { CoreInstance } from '../core/coreInstance'
import {
  resolveSessionCapabilityCatalog,
  type SessionCapabilityCatalog,
} from '../sessionCapabilityCatalog'

export type SessionCapabilityErrorCode =
  | 'session_missing'
  | 'legacy_read_only'
  | 'policy_locked'
  | 'capability_unavailable'
  | 'policy_changed'
  | 'persistence_failed'

export class SessionCapabilityError extends Error {
  constructor(readonly code: SessionCapabilityErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'SessionCapabilityError'
  }
}

export type ToggleSessionCapabilityResult =
  | { status: 'updated'; catalog: SessionCapabilityCatalog }
  | { status: 'unchanged'; catalog: SessionCapabilityCatalog }

export type LockSessionCapabilitiesResult =
  | { status: 'locked'; catalog: SessionCapabilityCatalog }
  | { status: 'already_locked'; catalog: SessionCapabilityCatalog }
  | { status: 'legacy-unrestricted'; catalog: SessionCapabilityCatalog }

interface SessionCreationCommands {
  newSession(options?: {
    settings?: ModelSettings
    workspaceId?: string
    capabilityPolicy?: SessionCapabilityPolicy
  }): string
}

function requestedSessionId(core: CoreInstance, sessionId?: string): string {
  const resolved = sessionId ?? core.rootStore.getter(activeSessionIdAtom)
  if (!resolved || !core.rootStore.getter(sessionsAtom)[resolved]) {
    throw new SessionCapabilityError('session_missing', 'Session does not exist.')
  }
  return resolved
}

async function requireCatalog(core: CoreInstance, sessionId: string): Promise<SessionCapabilityCatalog> {
  const catalog = await resolveSessionCapabilityCatalog(core, sessionId)
  if (!catalog) throw new SessionCapabilityError('session_missing', 'Session does not exist.')
  return catalog
}

function catalogSelections(catalog: SessionCapabilityCatalog) {
  return [...catalog.tools, ...catalog.skills]
}

async function persistLockedPolicy(core: CoreInstance, sessionId: string): Promise<void> {
  const outcome = await core.persistence.persistRecovery(sessionId, 'session_capability_locked')
  if (outcome) {
    if (outcome.status !== 'saved') {
      const cause = outcome.status === 'error' ? outcome.error : new Error(outcome.status)
      throw new SessionCapabilityError(
        'persistence_failed',
        'Session capability policy could not be persisted.',
        { cause },
      )
    }
    core.persistence.persistSessions({ reason: 'session_capability_locked', sessionId })
    return
  }

  const dependencies = core.persistence.dependencies()
  if (dependencies.recovery) {
    throw new SessionCapabilityError(
      'persistence_failed',
      'Recovery persistence is configured but unavailable for this session.',
    )
  }
  if (!dependencies.sessions) return
  const snapshot = Object.values(core.rootStore.getter(sessionsAtom)).map(projectStaticSessionMeta)
  try {
    await dependencies.sessions.saveSessions(snapshot)
  } catch (cause) {
    throw new SessionCapabilityError(
      'persistence_failed',
      'Session capability policy could not be persisted.',
      { cause },
    )
  }
}

/** Builds the session capability command surface bound to one runtime core. */
export function createSessionCapabilityCommands(
  core: CoreInstance,
  sessionCreation: SessionCreationCommands,
) {
  async function getSessionCapabilityCatalog(sessionId?: string): Promise<SessionCapabilityCatalog> {
    return requireCatalog(core, requestedSessionId(core, sessionId))
  }

  async function toggleDraftSessionCapability(
    kind: SessionCapabilityKind,
    name: string,
    selected: boolean,
    sessionId?: string,
  ): Promise<ToggleSessionCapabilityResult> {
    const id = requestedSessionId(core, sessionId)
    const catalog = await requireCatalog(core, id)
    const before = core.rootStore.getter(sessionsAtom)[id]
    if (!before) throw new SessionCapabilityError('session_missing', 'Session does not exist.')
    if (!before.capabilityPolicy) {
      throw new SessionCapabilityError('legacy_read_only', 'Legacy unrestricted sessions are read-only.')
    }
    if (before.capabilityPolicy.state === 'locked') {
      throw new SessionCapabilityError('policy_locked', 'Session capability policy is locked.')
    }
    if (sessionCapabilityPolicyVersion(before.capabilityPolicy) !== catalog.policyVersion) {
      throw new SessionCapabilityError('policy_changed', 'Session capability policy changed while loading.')
    }
    const item = (kind === 'tool' ? catalog.tools : catalog.skills)
      .find((candidate) => candidate.name === name && candidate.available)
    if (!item) throw new SessionCapabilityError('capability_unavailable', `Capability is unavailable: ${name}`)
    if (item.selected === selected) return { status: 'unchanged', catalog }

    const capabilityPolicy = toggleSessionCapability(before.capabilityPolicy, kind, name, selected)
    core.rootStore.setter(sessionsAtom, (sessions) => ({
      ...sessions,
      [id]: { ...before, capabilityPolicy, updatedAt: Date.now() },
    }))
    core.persistence.persistSessions({ reason: 'session_capability_toggled', sessionId: id })
    return { status: 'updated', catalog: await requireCatalog(core, id) }
  }

  async function lockSessionCapabilities(
    sessionId?: string,
    expectedPolicyVersion?: string,
  ): Promise<LockSessionCapabilitiesResult> {
    const id = requestedSessionId(core, sessionId)
    const catalog = await requireCatalog(core, id)
    const before = core.rootStore.getter(sessionsAtom)[id]
    if (!before) throw new SessionCapabilityError('session_missing', 'Session does not exist.')
    const policy = before.capabilityPolicy
    const actualVersion = sessionCapabilityPolicyVersion(policy)
    if (expectedPolicyVersion !== undefined && expectedPolicyVersion !== actualVersion) {
      throw new SessionCapabilityError('policy_changed', 'Session capability policy changed before locking.')
    }
    if (!policy) return { status: 'legacy-unrestricted', catalog }
    if (policy.state === 'locked') return { status: 'already_locked', catalog }
    if (actualVersion !== catalog.policyVersion) {
      throw new SessionCapabilityError('policy_changed', 'Session capability policy changed before locking.')
    }

    const capabilityPolicy = lockSessionCapabilityPolicy(policy, catalogSelections(catalog), Date.now())
    const locked = { ...before, capabilityPolicy, updatedAt: Date.now() }
    core.rootStore.setter(sessionsAtom, (sessions) => ({ ...sessions, [id]: locked }))
    try {
      await persistLockedPolicy(core, id)
    } catch (error) {
      core.rootStore.setter(sessionsAtom, (sessions) => {
        const current = sessions[id]
        if (!current || sessionCapabilityPolicyVersion(current.capabilityPolicy)
          !== sessionCapabilityPolicyVersion(capabilityPolicy)) return sessions
        return { ...sessions, [id]: before }
      })
      throw error
    }
    return { status: 'locked', catalog: await requireCatalog(core, id) }
  }

  async function cloneSessionCapabilities(sourceSessionId?: string): Promise<{
    status: 'created'
    sourceSessionId: string
    sessionId: string
  }> {
    const sourceId = requestedSessionId(core, sourceSessionId)
    const catalog = await requireCatalog(core, sourceId)
    const source = core.rootStore.getter(sessionsAtom)[sourceId]
    if (!source) throw new SessionCapabilityError('session_missing', 'Session does not exist.')
    if (sessionCapabilityPolicyVersion(source.capabilityPolicy) !== catalog.policyVersion) {
      throw new SessionCapabilityError('policy_changed', 'Session capability policy changed while copying.')
    }
    const capabilityPolicy = cloneSessionCapabilityPolicyAsDraft(
      source.capabilityPolicy,
      catalogSelections(catalog),
    )
    const sessionId = sessionCreation.newSession({
      settings: { ...source.settings },
      workspaceId: source.workspaceId,
      capabilityPolicy,
    })
    return { status: 'created', sourceSessionId: sourceId, sessionId }
  }

  return {
    getSessionCapabilityCatalog,
    toggleDraftSessionCapability,
    lockSessionCapabilities,
    cloneSessionCapabilities,
  }
}
