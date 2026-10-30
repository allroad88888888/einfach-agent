import { afterEach, expect, it, vi } from 'vitest'
import { createCoreInstance } from '../core/coreInstance'
import { createSessionCommands } from '../commands/sessionCommands'
import { configureHostInvoke, type HostInvoke } from '../hostBridge'
import { createServiceCapability } from './serviceCapability'

afterEach(() => configureHostInvoke(undefined))
it('injects owner and workspace cwd and blocks a removed session before host startup', async () => {
  const core = createCoreInstance(); const commands = createSessionCommands(core); const sessionId = commands.newSession()
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = []
  const invoke: HostInvoke = async <T>(command: string, args?: Record<string, unknown>) => { calls.push({ command, args }); return {} as T }
  configureHostInvoke({ loader: async () => invoke, platform: 'linux' })
  const controller = new AbortController()
  const capability = createServiceCapability({ sessionId, core, signal: controller.signal, guards: { assertFresh: vi.fn(), assertArchiveCurrent() {} }, workspaceRoot: '/workspace' })
  await capability.sessionService!('start', { command: 'npm run dev', sessionId: 'attacker' })
  expect(calls[0]).toEqual({ command: 'start_session_service', args: { command: 'npm run dev', sessionId, cwd: '/workspace' } })
  // A turn ending after successful startup does not send an implicit stop.
  controller.abort(); expect(calls).toHaveLength(1)
  commands.removeSession(sessionId)
  await expect(capability.sessionService!('start', { command: 'true' })).rejects.toThrow('closed')
  expect(calls.filter(call => call.command === 'start_session_service')).toHaveLength(1)
})
