import type { ListAgentHistoriesInput, ListAgentHistoryItemsInput, ReadAgentHistoryItemInput,
  SearchAgentHistoriesInput } from '@einfach-agent/core/history'
export interface HistoryCommandEnvelope<Input> { readonly input: Input; readonly legacyWorkspaceRoot?: string }
declare module '../commandArgs' {
  interface NodeHostCommandArgs {
    agent_history_list: HistoryCommandEnvelope<ListAgentHistoriesInput>
    agent_history_list_items: HistoryCommandEnvelope<ListAgentHistoryItemsInput>
    agent_history_read_item: HistoryCommandEnvelope<ReadAgentHistoryItemInput>
    agent_history_search: HistoryCommandEnvelope<SearchAgentHistoriesInput>
  }
}
