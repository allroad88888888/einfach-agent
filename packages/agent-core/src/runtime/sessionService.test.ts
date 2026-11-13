import { afterEach, describe, expect, it } from 'vitest'
import { createNodeHostInvoke } from '../../../host-node/src/createNodeHostInvoke'
import { configureHostInvoke } from './hostBridge'
import { createCoreInstance } from './core/coreInstance'
import { createSessionCommands } from './commands/sessionCommands'
import { createWorkspaceCommands } from './commands/workspaceCommands'
import { sessionsAtom } from '../state/rootStore'

const disposers: Array<() => Promise<void>> = []
afterEach(async () => { configureHostInvoke(undefined); await Promise.all(disposers.splice(0).map(d => d())) })
describe.skipIf(process.platform === 'win32')('session deletion host cleanup', () => {
  it.each(['session', 'workspace'])('%s deletion sends cleanup through the real host bridge', async deletion => {
    const invoke = createNodeHostInvoke({ registerHostDisposer: d => disposers.push(d) })
    configureHostInvoke({ loader: async () => invoke, platform: process.platform === 'darwin' ? 'macos' : 'linux' })
    const core = createCoreInstance()
    const commands = createSessionCommands(core)
    const sessionId = commands.newSession()
    const service = await invoke<{ serviceId: string }>('start_session_service', { sessionId, command: `${JSON.stringify(process.execPath)} -e 'setInterval(()=>{},1000)'` })
    if (deletion === 'session') commands.removeSession(sessionId)
    else {
      const workspaceId = core.rootStore.getter(sessionsAtom)[sessionId].workspaceId!
      createWorkspaceCommands(core, commands).removeWorkspace(workspaceId)
    }
    let removed = false
    for (let i = 0; i < 80; i++) {
      try { await invoke('get_session_service', { sessionId, serviceId: service.serviceId }) }
      catch { removed = true; break }
      await new Promise(r => setTimeout(r, 20))
    }
    expect(removed).toBe(true)
    await expect(invoke('start_session_service', { sessionId, command: 'true' })).rejects.toThrow('closed')
  })
})
