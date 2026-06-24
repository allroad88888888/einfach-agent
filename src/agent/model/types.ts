import type {
  AgentArtifact,
  AskUserAnswers,
  AskUserQuestionPayload,
  LoadedTool,
  ToolSummary,
} from '../runtime/types'

export type ModelProvider = 'mock' | 'deepseek'

export interface ModelConfig {
  provider: ModelProvider
  apiKey: string
  model: string
  baseUrl: string
}

export interface GenerateFinalAnswerInput {
  userInput: string
  answerContext?: AskUserAnswers
  loadedSkills: string[]
  loadedTools: string[]
  artifacts: AgentArtifact[]
  deterministicAnswer: string
  signal?: AbortSignal
}

export interface ModelAnswer {
  source: ModelProvider | 'fallback'
  content: string
  error?: string
}

export type AgentTurnResult =
  | {
      type: 'assistant_message'
      source: ModelProvider | 'fallback'
      content: string
      error?: string
    }
  | {
      type: 'tool_request'
      toolName: string
      reason: string
      toolCallId?: string
      continuation?: AgentTurnContinuation
    }
  | {
      type: 'tool_requests'
      requests: AgentTurnToolRequest[]
      continuation?: AgentTurnContinuation
    }
  | {
      type: 'tool_payload'
      toolName: string
      payload: unknown
      toolCallId?: string
      continuation?: AgentTurnContinuation
    }
  | {
      type: 'tool_payloads'
      calls: AgentTurnToolPayload[]
      continuation?: AgentTurnContinuation
    }

export interface AgentTurnContinuation {
  provider: ModelProvider
  state: unknown
}

export interface AgentTurnToolResult {
  toolName: string
  content: string
  toolCallId?: string
}

export interface AgentTurnToolRequest {
  toolName: string
  reason: string
  toolCallId?: string
}

export interface AgentTurnToolPayload {
  toolName: string
  payload: unknown
  toolCallId?: string
}

export type ModelStreamEvent =
  | {
      type: 'reasoning'
      content: string
    }
  | {
      type: 'content'
      content: string
    }
  | {
      type: 'tool_call'
      index: number
      id?: string
      name?: string
      argumentsDelta?: string
      arguments?: string
    }

export interface AgentTurnInput {
  userInput: string
  answerContext?: AskUserAnswers
  availableTools: ToolSummary[]
  loadedTools: LoadedTool[]
  loadedSkills: string[]
  artifacts: AgentArtifact[]
  deterministicAnswer: string
  continuation?: AgentTurnContinuation
  toolResult?: AgentTurnToolResult
  toolResults?: AgentTurnToolResult[]
  signal?: AbortSignal
  onStreamEvent?: (event: ModelStreamEvent) => void
}

export interface ModelAdapter {
  kind: ModelProvider
  runAgentTurn(input: AgentTurnInput): Promise<AgentTurnResult>
  generateFinalAnswer(input: GenerateFinalAnswerInput): Promise<ModelAnswer>
}
