export type RunStatus = 'idle' | 'running' | 'waiting_user' | 'done' | 'stopped' | 'error'

export type ChatRole = 'user' | 'assistant' | 'system'

export type TimelineStatus = 'pending' | 'running' | 'done' | 'error' | 'stopped'

export type TimelineKind = 'agent' | 'skill' | 'tool' | 'question' | 'model' | 'system'

export type ToolRuntime = 'internal' | 'browser' | 'server'

export type QuestionType = 'text' | 'single-choice' | 'multi-choice' | 'confirm'

export interface ChatMessage {
  id: string
  role: ChatRole
  content: string
  createdAt: number
  streaming?: boolean
}

export interface AgentSession {
  id: string
  title: string
  status: RunStatus
  createdAt: number
  updatedAt: number
}

export interface TimelineEvent {
  id: string
  runId: string
  kind: TimelineKind
  title: string
  detail?: string
  actor?: string
  status: TimelineStatus
  timestamp: number
}

export interface SkillSummary {
  name: string
  description: string
  triggers: string[]
}

export interface LoadedSkill extends SkillSummary {
  content: string
}

export interface ToolSummary {
  name: string
  description: string
  runtime: ToolRuntime
}

export interface LoadedTool extends ToolSummary {
  inputSchema: Record<string, unknown>
}

export interface AskUserQuestionItem {
  id: string
  text: string
  type: QuestionType
  options?: string[]
  required?: boolean
}

export interface AskUserQuestionPayload {
  id: string
  title?: string
  questions: AskUserQuestionItem[]
}

export type AskUserAnswerValue = string | string[] | boolean

export type AskUserAnswers = Record<string, AskUserAnswerValue>

export interface WorkerTask {
  id: string
  agentId: WorkerAgentId
  instruction: string
}

export type WorkerAgentId = 'skill-worker' | 'tool-worker' | 'answer-worker' | 'clarifier-worker'

export interface AgentArtifact {
  agentId: WorkerAgentId | 'main-architect' | 'deputy-architect'
  summary: string
  findings?: string[]
  proposedAnswer?: string
  questions?: AskUserQuestionPayload[]
  confidence: number
}

export interface AgentRunState {
  id: string
  sessionId: string
  status: RunStatus
  input: string
  loadedSkills: string[]
  loadedTools: string[]
  pendingQuestion?: AskUserQuestionPayload
  error?: string
}

export interface AgentContext {
  sessionId: string
  runId: string
  input: string
  answerContext?: AskUserAnswers
  loadedSkills: LoadedSkill[]
  loadedTools: LoadedTool[]
}

export interface MainArchitectPlan {
  summary: string
  tasks: WorkerTask[]
}

export interface RuntimeResult {
  status: RunStatus
  answer?: string
  question?: AskUserQuestionPayload
}
