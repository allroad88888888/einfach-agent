// tools/context.ts —— 工具执行上下文的唯一能力合同。
//
// 这里定义工具可获得的副作用白名单。运行时装配在 runtime/toolContext.ts，工具侧只依赖本合同。

import type { AgentHistoryCapability } from '../history/historyQuery'
import type { DelegateAgentBatchResult, DelegateAgentInput } from '../runtime/delegationContract'
import type {
  ExecutionHandle,
  ExecutionJoinResult,
  ExecutionObservation,
} from '../execution/types'
import type {
  CreatePlanInput,
  PlanMutationResult,
  PlanSnapshot,
  SubmitStageResultInput,
  UpdatePlanInput,
} from '../planning/types'
import type { SkillSummary } from '../skills/contracts'
import type { ShellCommandInput, ShellCommandResult } from './shellCommandTypes'
import type { ToolResult, WorkspaceTaskInput, WorkspaceTaskResult } from './types'
import type {
  ViewImageInput,
  ViewImageResult,
  WorkspaceImageReadInput,
  WorkspaceImageReadResult,
} from './visionToolTypes'

export interface SpawnAgentsOptions {
  /** Runs inside the background execution before its node becomes succeeded. */
  onComplete?(result: DelegateAgentBatchResult): unknown | Promise<unknown>
  /** Best-effort compensation hook before the execution node becomes failed. */
  onError?(error: unknown): void | Promise<void>
}

/** 工具拿到的唯一副作用面（白名单）。 */
export interface ToolContext {
  readonly sessionId: string
  readonly signal: AbortSignal
  progress(text: string): void
  callTool(name: string, args: unknown): Promise<ToolResult>
  runLowCostExtraction?(input: {
    systemPrompt: string
    userPrompt: string
    maxOutputTokens?: number
  }): Promise<{ content: string; model: string }>
  spawnAgents?(input: DelegateAgentInput, options?: SpawnAgentsOptions): ExecutionHandle
  observeExecution?(executionId: string): ExecutionObservation
  joinExecution?(executionId: string, timeoutMs?: number): Promise<ExecutionJoinResult>
  cancelExecution?(executionId: string): boolean
  getPlan?(): PlanSnapshot | undefined
  createPlan?(input: CreatePlanInput): Promise<PlanMutationResult>
  executePlan?(planId: string, revision: number): Promise<PlanMutationResult>
  updatePlan?(input: UpdatePlanInput): Promise<PlanMutationResult>
  submitStageResult?(input: SubmitStageResultInput): Promise<PlanMutationResult>
  runShell(input: ShellCommandInput): Promise<ShellCommandResult>
  readWorkspaceFile?(input: {
    path: string
    maxBytes?: number
    offset?: number
    workspaceRoot?: string
    allowExternalPaths?: boolean
  }): Promise<unknown>
  readWorkspaceImage?(input: WorkspaceImageReadInput): Promise<WorkspaceImageReadResult>
  viewImage?(input: ViewImageInput): Promise<ViewImageResult>
  listWorkspaceFiles?(input: {
    path?: string
    recursive?: boolean
    maxEntries?: number
    includeHidden?: boolean
    workspaceRoot?: string
    allowExternalPaths?: boolean
  }): Promise<unknown>
  searchWorkspaceFiles?(input: {
    query: string
    path?: string
    glob?: string
    maxMatches?: number
    workspaceRoot?: string
    allowExternalPaths?: boolean
  }): Promise<unknown>
  rgSearchWorkspace?(input: {
    query: string
    path?: string
    regex?: boolean
    caseSensitive?: boolean
    globs?: string[]
    contextLines?: number
    maxMatches?: number
    workspaceRoot?: string
    allowExternalPaths?: boolean
  }): Promise<unknown>
  applyWorkspacePatch?(input: unknown): Promise<unknown>
  writeWorkspaceFile?(input: unknown): Promise<unknown>
  deleteWorkspacePath?(input: unknown): Promise<unknown>
  copyWorkspacePath?(input: unknown): Promise<unknown>
  moveWorkspacePath?(input: unknown): Promise<unknown>
  revertWorkspaceChange?(input: unknown): Promise<unknown>
  getWorkspaceDiff?(input?: unknown): Promise<unknown>
  runWorkspaceTask?(input: WorkspaceTaskInput): Promise<WorkspaceTaskResult>
  renderCard(card: { title: string; body?: string }): { cardId: string } | { error: string }
  saveArtifact(file: { filename: string; content: string; mimeType?: string }):
    | { artifactId: string }
    | { error: string }
  skills?: {
    list(): SkillSummary[]
    resolveScannedSkill(name: string): {
      filePath: string
      resources: Record<string, string>
      rootPath: string
    } | undefined
  }
  /** Optional read-only access to all locally catalogued agent histories. */
  agentHistory?: AgentHistoryCapability
}
