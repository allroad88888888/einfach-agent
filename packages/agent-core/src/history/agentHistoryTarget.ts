export type AgentHistoryTarget =
  | { readonly kind: 'root'; readonly conversationId: string }
  | {
      readonly kind: 'child'
      readonly conversationId: string
      readonly runId: string
      readonly agentPath: string
    }
