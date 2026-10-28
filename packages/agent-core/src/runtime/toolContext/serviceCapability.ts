import type { ToolContext } from '../../tools/context'
import type { CoreInstance } from '../core/coreInstance'
import { sessionsAtom } from '../../state/rootStore'
import { loadHostInvoke } from '../hostBridge'
import type { ToolStaleGuards } from './staleGuards'

const commands = { start: 'start_session_service', status: 'get_session_service', logs: 'read_session_service_logs', stop: 'stop_session_service' } as const
export function createServiceCapability(deps: {
  sessionId: string; core: CoreInstance; guards: ToolStaleGuards; signal: AbortSignal; workspaceRoot?: string
}): Pick<ToolContext, 'sessionService'> {
  return {
    async sessionService(action, input) {
      deps.guards.assertFresh()
      const invoke = await loadHostInvoke()
      deps.guards.assertFresh()
      if (!deps.core.rootStore.getter(sessionsAtom)[deps.sessionId]) throw new Error('Service session is closed')
      const args = { ...input, sessionId: deps.sessionId }
      if (action === 'start' && !input.cwd && deps.workspaceRoot) Object.assign(args, { cwd: deps.workspaceRoot })
      const result = await invoke(commands[action], args, action === 'start' ? { signal: deps.signal } : undefined)
      // A completed start belongs to the session, not to this model turn's AbortSignal.
      return result
    },
  }
}
