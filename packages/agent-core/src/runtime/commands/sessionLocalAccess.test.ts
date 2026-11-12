import { afterEach, describe, expect, it, vi } from 'vitest'
import { sessionsAtom } from '../../state/rootStore'
import { runAtom } from '../../state/sessionAtoms'
import { captureRecoverySnapshot } from '../../state/recoveryProjection'
import { decodeRecoverySnapshot } from '../../state/recoverySnapshot.codec'
import { createCoreInstance } from '../core/coreInstance'
import { createSessionCommands } from './sessionCommands'
import { createWorkspaceInputGuards } from '../toolContext/workspaceInputGuards'
import { buildToolContext } from '../toolContext'
import { configureHostInvoke, type HostInvoke } from '../hostBridge'

afterEach(() => configureHostInvoke(undefined))

describe('session local access selection', () => {
  it('persists each session independently and includes access in recovery snapshots', () => {
    const core = createCoreInstance()
    const commands = createSessionCommands(core)
    const persist = vi.spyOn(core.persistence, 'persistSessions')
    const recovery = vi.spyOn(core.persistence, 'persistRecovery')
    const first = commands.newSession()
    commands.setLocalAccessMode('full')
    expect(core.rootStore.getter(sessionsAtom)[first].localAccessMode).toBe('full')
    expect(persist).toHaveBeenCalled()
    expect(recovery).toHaveBeenCalledWith(first, 'local_access_changed')
    const snapshot = captureRecoverySnapshot(core.getSessionStore(first).store, {
      rootStore: core.rootStore, sessionId: first, generation: 1, capturedAt: Date.now(),
    })
    expect(snapshot.session.localAccessMode).toBe('full')
    expect(decodeRecoverySnapshot(snapshot)?.session.localAccessMode).toBe('full')
    expect(decodeRecoverySnapshot({ ...snapshot, session: { ...snapshot.session, localAccessMode: 'invalid' } })).toBeUndefined()
    const second = commands.newSession()
    expect(core.rootStore.getter(sessionsAtom)[second].localAccessMode ?? 'workspace').toBe('workspace')
    commands.selectSession(first)
    commands.setLocalAccessMode('workspace')
    expect(core.rootStore.getter(sessionsAtom)[first].localAccessMode).toBe('workspace')
  })

  it('does not change access during an active task', () => {
    const core = createCoreInstance()
    const commands = createSessionCommands(core)
    const id = commands.newSession()
    core.getSessionStore(id).store.setter(runAtom, { runId: 'r', status: 'running' })
    commands.setLocalAccessMode('full')
    expect(core.rootStore.getter(sessionsAtom)[id].localAccessMode).toBeUndefined()
  })

  it('strips forged permissions and replaces the tool-provided workspace root', () => {
    const guards = createWorkspaceInputGuards({
      sessionId: 's', runId: 'r', callId: 'c', workspaceRoot: '/workspace',
      fullLocalAccess: false,
    })
    expect(guards.withWorkspaceReadAccess({
      path: '/outside/file', workspaceRoot: '/', allowExternalPaths: true,
      fullLocalAccess: true, full_local_access: true, allow_external_paths: true,
    })).toEqual({ path: '/outside/file', workspaceRoot: '/workspace' })
  })

  it.each(['workspace', 'full'] as const)('sends %s access through real tool-context bridges independently of Auto', async (mode) => {
    const invoke = vi.fn(async () => ({ ok: true }))
    configureHostInvoke({ loader: async () => invoke as HostInvoke, platform: 'macos' })
    const core = createCoreInstance()
    const commands = createSessionCommands(core)
    const id = commands.newSession()
    commands.setApprovalMode(mode === 'workspace' ? 'auto' : 'confirm')
    commands.setLocalAccessMode(mode)
    core.getSessionStore(id).store.setter(runAtom, { runId: 'r', status: 'running' })
    const ctx = buildToolContext({
      sessionId: id, runId: 'r', signal: new AbortController().signal, callId: 'c', toolName: 'x', core,
    })
    await ctx.readWorkspaceFile!({ path: '/outside/file' })
    await ctx.writeWorkspaceFile!({ path: '/outside/file', content: 'test' })
    await ctx.applyWorkspacePatch!({ operations: [] })
    await ctx.copyWorkspacePath!({ source: '/outside/file', destination: '/outside/copy' })
    await ctx.moveWorkspacePath!({ source: '/outside/copy', destination: '/outside/move' })
    await ctx.deleteWorkspacePath!({ path: '/outside/file' })
    await ctx.revertWorkspaceChange!({ changeSetId: 'change' })
    const calls = invoke.mock.calls as unknown as [string, Record<string, unknown>][]
    expect(calls).toHaveLength(7)
    expect(calls[0][1].allow_external_paths === true).toBe(mode === 'full')
    for (const [, args] of calls.slice(1)) {
      expect(args.full_local_access === true).toBe(mode === 'full')
    }
  })
})
