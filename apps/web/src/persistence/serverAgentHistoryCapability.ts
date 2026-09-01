import type {
  AgentHistoryCapabilityProvider,
  ListAgentHistoriesResult,
  ListAgentHistoryItemsResult,
  ReadAgentHistoryItemResult,
  SearchAgentHistoriesResult,
} from '@einfach-agent/core/history'
import { AgentHistoryError, isAgentHistoryErrorCode } from '@einfach-agent/core/history'
import type { HostInvoke } from '@einfach-agent/core'
import { invokeServerCommand, ServerInvokeError } from '../host/serverInvoke'

const structuredServerInvoke: HostInvoke = (command, args) => invokeServerCommand(command, args)

async function invokeHistory<T>(
  invoke: HostInvoke,
  command: string,
  args: Record<string, unknown>,
): Promise<T> {
  try {
    return await invoke<T>(command, args)
  } catch (error) {
    if (error instanceof ServerInvokeError && isAgentHistoryErrorCode(error.code)) {
      throw new AgentHistoryError(error.code, error.message, { cause: error })
    }
    throw error
  }
}

/**
 * Adapts the four server history commands to a workspace-bound provider.
 * Production uses the structured transport; an injected HostInvoke passes through the same error mapper.
 */
export function createServerAgentHistoryCapability(
  invoke: HostInvoke = structuredServerInvoke,
): AgentHistoryCapabilityProvider {
  return {
    forContext({ legacyWorkspaceRoot }) {
      const envelope = (input: unknown) => ({
        input,
        ...(legacyWorkspaceRoot ? { legacyWorkspaceRoot } : {}),
      })
      return {
        listHistories(input): Promise<ListAgentHistoriesResult> {
          return invokeHistory(invoke, 'agent_history_list', envelope(input))
        },
        listItems(input): Promise<ListAgentHistoryItemsResult> {
          return invokeHistory(invoke, 'agent_history_list_items', envelope(input))
        },
        readItem(input): Promise<ReadAgentHistoryItemResult> {
          return invokeHistory(invoke, 'agent_history_read_item', envelope(input))
        },
        search(input): Promise<SearchAgentHistoriesResult> {
          return invokeHistory(invoke, 'agent_history_search', envelope(input))
        },
      }
    },
  }
}
