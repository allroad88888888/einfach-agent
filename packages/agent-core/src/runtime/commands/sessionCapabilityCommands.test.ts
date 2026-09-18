import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../modelRun', () => ({
  runSession: vi.fn(() => Promise.resolve()),
  runToolLoop: vi.fn(() => Promise.resolve()),
  resumeInterruptedSession: vi.fn(() => Promise.resolve()),
  resumePlanSession: vi.fn(() => Promise.resolve()),
}))

import type { Tool } from '../../tools/types'
import { activeSessionIdAtom, sessionsAtom } from '../../state/rootAtoms'
import { runAtom } from '../../state/sessionAtoms'
import { setRun } from '../../state/sessionWriters'
import { createMemoryRecoveryDriver, type RecoveryDriver } from '../../state/persistence/recoveryDriver'
import { createCoreInstance, type CoreInstance } from '../core/coreInstance'
import { runSession } from '../modelRun'
import { createCommands } from '../commands'
import { SessionCapabilityError } from './sessionCapabilityCommands'

function tool(name: string): Tool {
  return {
    name,
    runtime: 'internal',
    skill: { description: `${name} description`, content: `${name} guide` },
    inputSchema: { type: 'object' },
    execute: () => ({ ok: true }),
  }
}

function setup(): { core: CoreInstance; commands: ReturnType<typeof createCommands>; sessionId: string } {
  const core = createCoreInstance({ config: { modelCredentials: { deepseek: 'key' } } })
  core.tools.register(tool('alpha'))
  core.tools.register(tool('beta'))
  const commands = createCommands(core)
  const sessionId = commands.newSession()
  return { core, commands, sessionId }
}

function configureRecovery(core: CoreInstance, recovery: RecoveryDriver): void {
  core.persistence.configure({
    recovery,
    recoveryStore: (sessionId) => core.findSessionStore(sessionId)?.store,
  })
}

beforeEach(() => {
  vi.mocked(runSession).mockReset()
  vi.mocked(runSession).mockResolvedValue(undefined)
})

describe('session capability commands', () => {
  it('creates an explicit draft, reads current/specified sessions, and toggles only drafts', async () => {
    const { core, commands, sessionId } = setup()

    expect(core.rootStore.getter(sessionsAtom)[sessionId].capabilityPolicy).toMatchObject({
      version: 1,
      state: 'draft',
      disabledTools: [],
      disabledSkills: [],
    })
    const updated = await commands.toggleDraftSessionCapability('tool', 'alpha', false, sessionId)

    expect(updated.status).toBe('updated')
    expect(updated.catalog.tools.find((item) => item.name === 'alpha')?.selected).toBe(false)
    await commands.lockSessionCapabilities(sessionId)
    await expect(commands.toggleDraftSessionCapability('tool', 'alpha', true, sessionId))
      .rejects.toMatchObject({ code: 'policy_locked' })
  })

  it('keeps legacy sessions unrestricted and read-only, cloning them with safe current defaults', async () => {
    const { core, commands, sessionId } = setup()
    const session = core.rootStore.getter(sessionsAtom)[sessionId]
    const { capabilityPolicy: _policy, ...legacy } = session
    core.rootStore.setter(sessionsAtom, { [sessionId]: legacy })

    expect((await commands.getSessionCapabilityCatalog()).state).toBe('legacy-unrestricted')
    await expect(commands.toggleDraftSessionCapability('tool', 'alpha', false))
      .rejects.toMatchObject({ code: 'legacy_read_only' })
    const cloned = await commands.cloneSessionCapabilities(sessionId)

    expect(core.rootStore.getter(sessionsAtom)[cloned.sessionId].capabilityPolicy).toEqual({
      version: 1,
      state: 'draft',
      revision: 0,
      disabledTools: [],
      disabledSkills: [],
    })
  })

  it('clones a locked policy as a draft without re-enabling denied or disappeared entries', async () => {
    const { core, commands, sessionId } = setup()
    await commands.toggleDraftSessionCapability('tool', 'alpha', false)
    await commands.lockSessionCapabilities(sessionId)
    core.tools.unregister('beta')

    const cloned = await commands.cloneSessionCapabilities(sessionId)
    const clonePolicy = core.rootStore.getter(sessionsAtom)[cloned.sessionId].capabilityPolicy

    expect(clonePolicy).toEqual({
      version: 1,
      state: 'draft',
      revision: 0,
      disabledTools: ['alpha', 'beta'],
      disabledSkills: [],
    })
  })

  it('persists a concrete sorted allowlist through recovery before starting the model', async () => {
    const { core, commands, sessionId } = setup()
    const recovery = createMemoryRecoveryDriver()
    configureRecovery(core, recovery)
    await commands.toggleDraftSessionCapability('tool', 'beta', false)
    let policyAtRun: unknown
    vi.mocked(runSession).mockImplementationOnce(() => {
      policyAtRun = core.rootStore.getter(sessionsAtom)[sessionId].capabilityPolicy
      return Promise.resolve()
    })

    const result = await commands.sendMessage('hello')
    const persisted = await recovery.loadLatest(sessionId)

    expect(result).toMatchObject({ accepted: true, status: 'started' })
    expect(policyAtRun).toMatchObject({ state: 'locked', allowedTools: ['alpha'] })
    expect(persisted?.session.capabilityPolicy).toEqual(policyAtRun)
  })

  it('does not lock empty or preparation-failed input', async () => {
    const { core, commands, sessionId } = setup()
    core.config.prepareUserInput = async () => { throw new Error('upload failed') }

    expect(await commands.sendMessage('')).toMatchObject({ accepted: false, reason: 'empty' })
    expect(await commands.sendMessage('hello')).toMatchObject({ accepted: false, reason: 'prepare_failed' })
    expect(core.rootStore.getter(sessionsAtom)[sessionId].capabilityPolicy?.state).toBe('draft')
    expect(runSession).not.toHaveBeenCalled()
  })

  it('rejects a draft edit racing preparation instead of locking the stale snapshot', async () => {
    const { core, commands, sessionId } = setup()
    let release!: () => void
    core.config.prepareUserInput = () => new Promise((resolve) => {
      release = () => resolve({ content: 'prepared' })
    })
    const sending = commands.sendMessage('hello')
    await commands.toggleDraftSessionCapability('tool', 'alpha', false)
    release()

    expect(await sending).toMatchObject({ accepted: false, reason: 'capabilities_changed' })
    expect(core.rootStore.getter(sessionsAtom)[sessionId].capabilityPolicy?.state).toBe('draft')
    expect(runSession).not.toHaveBeenCalled()
  })

  it('rolls back a failed lock persistence and never starts the model', async () => {
    const { core, commands, sessionId } = setup()
    const base = createMemoryRecoveryDriver()
    configureRecovery(core, {
      ...base,
      saveLatest: async () => { throw new Error('disk full') },
    })

    const result = await commands.sendMessage('hello')

    expect(result).toMatchObject({ accepted: false, reason: 'commit_failed' })
    if (result.accepted) throw new Error('Expected lock persistence rejection')
    expect(result.error).toContain('could not be persisted')
    expect(core.rootStore.getter(sessionsAtom)[sessionId].capabilityPolicy?.state).toBe('draft')
    expect(runSession).not.toHaveBeenCalled()
  })

  it('awaits a sessions-only persistence driver and fails closed on its rejection', async () => {
    const { core, commands, sessionId } = setup()
    core.persistence.configure({
      sessions: {
        saveSessions: async () => { throw new Error('sessions disk full') },
        loadSessions: async () => [],
        saveWorkspaces: async () => {},
        loadWorkspaces: async () => [],
      },
    })

    expect(await commands.sendMessage('hello')).toMatchObject({
      accepted: false,
      reason: 'commit_failed',
    })
    expect(core.rootStore.getter(sessionsAtom)[sessionId].capabilityPolicy?.state).toBe('draft')
    expect(runSession).not.toHaveBeenCalled()
  })

  it('does not change the locked allowlist on repeated sends', async () => {
    const { core, commands, sessionId } = setup()
    configureRecovery(core, createMemoryRecoveryDriver())
    await commands.sendMessage('first')
    const locked = core.rootStore.getter(sessionsAtom)[sessionId].capabilityPolicy

    expect(await commands.sendMessage('second')).toMatchObject({ accepted: true, status: 'started' })
    expect(core.rootStore.getter(sessionsAtom)[sessionId].capabilityPolicy).toEqual(locked)
  })

  it('serializes two concurrent first sends, locks once, and queues without widening', async () => {
    const { core, commands, sessionId } = setup()
    await commands.toggleDraftSessionCapability('tool', 'beta', false)
    const saveSessions = vi.fn(async () => {})
    core.persistence.configure({
      sessions: {
        saveSessions,
        loadSessions: async () => [],
        saveWorkspaces: async () => {},
        loadWorkspaces: async () => [],
      },
    })
    vi.mocked(runSession).mockImplementationOnce(async () => {
      setRun(sessionId, { runId: 'first-run', status: 'running' }, core)
      core.tools.register(tool('late'))
    })

    const [first, second] = await Promise.all([
      commands.sendMessage('first'),
      commands.sendMessage('second'),
    ])

    expect(first).toMatchObject({ accepted: true, status: 'started' })
    expect(second).toMatchObject({ accepted: true, status: 'queued' })
    // One write locks the capability policy; the other persists the first-message title.
    expect(saveSessions).toHaveBeenCalledTimes(2)
    expect(core.rootStore.getter(sessionsAtom)[sessionId].capabilityPolicy).toMatchObject({
      state: 'locked',
      allowedTools: ['alpha'],
    })
  })

  it('keeps the policy locked through stop and undo/redo lifecycle commands', async () => {
    const { core, commands, sessionId } = setup()
    configureRecovery(core, createMemoryRecoveryDriver())
    vi.mocked(runSession).mockImplementationOnce(async () => {
      setRun(sessionId, { runId: 'lifecycle-run', status: 'running' }, core)
    })
    await commands.sendMessage('start')
    const locked = core.rootStore.getter(sessionsAtom)[sessionId].capabilityPolicy

    commands.stopRun()
    expect(core.rootStore.getter(sessionsAtom)[sessionId].capabilityPolicy).toEqual(locked)
    setRun(sessionId, { runId: 'lifecycle-run', turnId: 'checkpoint', status: 'stopped' }, core)
    expect(commands.undoEntry().ok).toBe(true)
    expect(core.rootStore.getter(sessionsAtom)[sessionId].capabilityPolicy).toEqual(locked)
    expect(commands.redoEntry().ok).toBe(true)
    expect(core.rootStore.getter(sessionsAtom)[sessionId].capabilityPolicy).toEqual(locked)
    await expect(commands.toggleDraftSessionCapability('tool', 'alpha', false))
      .rejects.toMatchObject({ code: 'policy_locked' })
  })

  it('does not lock a draft when its current run rejects submission', async () => {
    const { core, commands, sessionId } = setup()
    core.getSessionStore(sessionId).store.setter(runAtom, {
      runId: 'blocked',
      status: 'waiting_user',
    })

    expect(await commands.sendMessage('blocked')).toMatchObject({ accepted: false, reason: 'run_blocked' })
    expect(core.rootStore.getter(sessionsAtom)[sessionId].capabilityPolicy?.state).toBe('draft')
  })

  it('throws stable domain errors for missing and unavailable capability requests', async () => {
    const { commands } = setup()

    await expect(commands.getSessionCapabilityCatalog('missing'))
      .rejects.toEqual(expect.objectContaining<Partial<SessionCapabilityError>>({ code: 'session_missing' }))
    await expect(commands.toggleDraftSessionCapability('tool', 'missing', false))
      .rejects.toMatchObject({ code: 'capability_unavailable' })
  })
})
