// Visible-text prefixes the loop uses to COMPOSE the two runtime-scaffolding
// messages (the AskUser "我需要先确认…" placeholder and the "已补充:" answer echo).
// MF7: these are for text composition only — scaffolding is now detected via the
// structural `scaffold` marker, never by matching these prefixes (a real message
// may legitimately start with the same text).
export const ASK_USER_PLACEHOLDER_PREFIX = '我需要先确认'
export const USER_ANSWERS_ECHO_PREFIX = '已补充：'

export type RunStatus = 'idle' | 'running' | 'waiting_user' | 'done' | 'stopped' | 'error'

export type ChatRole = 'user' | 'assistant' | 'system'

export type TimelineStatus = 'pending' | 'running' | 'done' | 'error' | 'stopped'

export type TimelineKind = 'agent' | 'skill' | 'tool' | 'question' | 'model' | 'system'

export type ToolRuntime = 'internal' | 'browser' | 'server'

export type QuestionType = 'text' | 'single-choice' | 'multi-choice' | 'confirm'

// MF7: runtime-generated scaffolding messages carry a structural marker so the
// conversation-context builder can exclude them deterministically — never by
// sniffing content prefixes (a real user/assistant message may legitimately
// start with "已补充：" or "我需要先确认"). Absent on all real messages.
export type ChatScaffoldKind = 'ask-placeholder' | 'answer-echo'

export interface ChatMessage {
  id: string
  role: ChatRole
  content: string
  createdAt: number
  streaming?: boolean
  scaffold?: ChatScaffoldKind
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
  // M1.3: the messages length captured at run start (before the current-run
  // user was appended) = the history cutoff for conversation-memory injection.
  // AskUser resume reuses the same boundary so the whole run stays out of
  // history. Optional/back-compatible; persistence wiring lands in M3.
  historyEndIndex?: number
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
