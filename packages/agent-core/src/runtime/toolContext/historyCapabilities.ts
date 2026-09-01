import type { AgentHistoryCapabilityProvider } from '../../history'
import type { ToolContext } from '../../tools/types'

/** Binds the host-owned history provider to the current workspace context. */
export function createHistoryCapabilities(
  provider: AgentHistoryCapabilityProvider | undefined,
  workspaceRoot: string | undefined,
): Pick<ToolContext, 'agentHistory'> | Record<never, never> {
  if (!provider) return {}
  return {
    agentHistory: provider.forContext({
      ...(workspaceRoot ? { legacyWorkspaceRoot: workspaceRoot } : {}),
    }),
  }
}
