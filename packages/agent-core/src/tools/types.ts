// tools/types.ts —— 工具统一抽象的类型（见 TOOLS-SPEC.md §2）。
// 零依赖：不 import runtime/state/UI，工具与工厂都只依赖本文件。

import type { DelegateAgentBatchResult, DelegateAgentInput } from '../subagents/types'
import type {
  CreatePlanInput,
  EvaluatePlanInput,
  EvaluateStageInput,
  PlanMutationResult,
  SubmitStageResultInput,
  UpdatePlanInput,
} from '../planning/types'
import type {
  ExecutionHandle,
  ExecutionJoinResult,
  ExecutionObservation,
} from '../execution/types'

/**
 * tool 的执行位置：
 *   · internal —— 纯内置逻辑，任意环境可用。
 *   · browser  —— 浏览器侧副作用（渲卡片 / 存产物）。
 *   · server   —— 依赖 Tauri 原生能力（本机 shell / 文件系统 / git）；web 下不可用、不进 manifest（TP3）。
 */
export type ToolRuntime = 'internal' | 'browser' | 'server'

/** manifest-only 摘要——model 只看这一层。description 取自 tool.skill.description（terse，TK3/TK4）。 */
export interface ToolSummary {
  name: string
  description: string
  runtime: ToolRuntime
}

/** 懒加载后补出 schema + 指南正文；schema 进下一轮 tools，guide 进一次性工具结果。 */
export interface LoadedTool extends ToolSummary {
  /**
   * 当前注册实例的单调递增版本。
   *
   * ToolRegistry.loadSchema 返回的快照始终包含该值；保留可选是为了兼容手工构造的
   * LoadedTool（例如宿主预置的临时可见工具）。
   */
  registrationVersion?: number
  inputSchema: Record<string, unknown>
  guide: string
}

/** ToolRegistry.loadSchema 返回的、可用于识别当前注册实例的完整快照。 */
export interface RegisteredToolSnapshot extends LoadedTool {
  registrationVersion: number
}

/**
 * 每个工具自带的 skill（取代裸 description）：一句话摘要 + 可选触发词 + 完整指南正文。
 * 与 skills/registry 的 skill 同形，工具因此自文档化。description 进 manifest；content 只经 loadSchema 给 model。
 */
export interface ToolSkill {
  description: string
  triggers?: string[]
  content: string
}

/**
 * 工具执行结果（判别联合）。harness 负责映射成回给 model 的 tool-result：
 *   { ok:true, data } → JSON.stringify(data ?? { ok:true })
 *   { ok:true, data, warnings } → JSON.stringify({ data, warnings })  —— 见下
 *   { ok:false, error } → JSON.stringify({ error })      —— TK6，不打断循环
 *   { pause } → 置 waiting_user，不回填该 tool（ask_user，见 §7）
 *
 * warnings：参数在 schema 校验阶段被【自动改过】时的告知（目前只有 maximum 钳位会产生）。
 * 必须回给 model —— 否则它请求 maxMatches:5000 拿到 200 条、请求 contextLines:20 拿到 5 行，
 * 却收不到任何「你的参数被改过」的信号，会把截断结果当完整结果继续推理，或反复重发同一个越界值。
 * 工具自身通常不需要设置它，由 registry 在校验后附加。
 */
export type ToolResult =
  | { ok: true; data?: unknown; warnings?: string[] }
  | { ok: false; error: string }
  | { pause: unknown }

export type ShellPlatform = 'macos' | 'linux' | 'windows'

export interface ShellCommandInput {
  platform: ShellPlatform
  command: string
  cwd?: string
  timeoutMs?: number
  maxOutputChars?: number
  env?: Record<string, string>
}

export interface ShellCommandResult {
  platform: ShellPlatform
  shell: string
  command: string
  cwd: string
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
  truncated: boolean
  /** Present and false for shell deletion, which cannot produce a recoverable change set. */
  reversible?: false
}

export type WorkspaceTaskKind = 'test' | 'build' | 'lint' | 'typecheck' | 'cargo_check'

export interface SpawnAgentsOptions {
  /**
   * Runs inside the background execution before its node becomes succeeded.
   * This is used by orchestration tools to atomically apply a child result to
   * their own state machine without making the parent model loop wait.
   */
  onComplete?(result: DelegateAgentBatchResult): unknown | Promise<unknown>
  /**
   * Best-effort compensation hook. The execution node still becomes failed
   * after this hook returns.
   */
  onError?(error: unknown): void | Promise<void>
}

export interface WorkspaceTaskInput {
  kind: WorkspaceTaskKind
  timeoutMs?: number
  maxOutputChars?: number
  workspaceRoot?: string
}

export interface WorkspaceTaskResult {
  ok: boolean
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
  truncated: boolean
  command: string[]
  cwd: string
  kind: WorkspaceTaskKind | string
}

/**
 * 工具拿到的唯一副作用面（白名单）。工具不 import 任何 atom/store —— 一切副作用都在这里，
 * 由 harness 实现 + 集中施加 ghost/stale 守卫。
 */
export interface ToolContext {
  readonly sessionId: string
  readonly signal: AbortSignal
  /** 显示「工具正在干啥」。harness 写会话 store 的瞬态 toolActivityAtom（含 isCurrent 守卫）。 */
  progress(text: string): void
  /** 工具互调：经工厂转发，harness 加防环/限深/signal 透传（见 §8）。 */
  callTool(name: string, args: unknown): Promise<ToolResult>
  /** 启动树形 headless 子 agent；由 root runtime 注入，普通工具只能经该能力派活。 */
  delegateAgents?(input: DelegateAgentInput): Promise<DelegateAgentBatchResult>
  /** 非阻塞启动子 agent；立即返回可观察、可显式等待的执行句柄。 */
  spawnAgents?(input: DelegateAgentInput, options?: SpawnAgentsOptions): ExecutionHandle
  /** 读取后台执行节点，不等待它完成。 */
  observeExecution?(executionId: string): ExecutionObservation
  /** 显式等待后台执行节点。 */
  joinExecution?(executionId: string): Promise<ExecutionJoinResult>
  /** 取消一个后台执行节点。 */
  cancelExecution?(executionId: string): boolean
  /** 结构化计划能力。状态由宿主的 PlanRuntime 管理，工具不得直接访问 atom/store。 */
  createPlan?(input: CreatePlanInput): PlanMutationResult
  executePlan?(planId: string, revision: number): PlanMutationResult
  updatePlan?(input: UpdatePlanInput): PlanMutationResult
  submitStageResult?(input: SubmitStageResultInput): PlanMutationResult
  evaluateStage?(input: EvaluateStageInput): PlanMutationResult
  evaluatePlan?(input: EvaluatePlanInput): PlanMutationResult
  abortStageEvaluation?(planId: string, revision: number, stageId: string, reason: string): PlanMutationResult
  /** 执行桌面 shell command。工具只经 ctx 调用，Tauri invoke 细节集中在 runtime 桥接层。 */
  runShell(input: ShellCommandInput): Promise<ShellCommandResult>
  /** 读取 workspace 内文本文件。具体 Tauri invoke 细节集中在 runtime 桥接层。 */
  readWorkspaceFile?(input: { path: string; maxBytes?: number; workspaceRoot?: string }): Promise<unknown>
  /** 列出 workspace 内文件。具体 Tauri invoke 细节集中在 runtime 桥接层。 */
  listWorkspaceFiles?(input: {
    path?: string
    recursive?: boolean
    maxEntries?: number
    includeHidden?: boolean
    workspaceRoot?: string
  }): Promise<unknown>
  /** 搜索 workspace 内文本文件。具体 Tauri invoke 细节集中在 runtime 桥接层。 */
  searchWorkspaceFiles?(input: {
    query: string
    path?: string
    glob?: string
    maxMatches?: number
    workspaceRoot?: string
  }): Promise<unknown>
  /** 用 ripgrep 搜索 workspace。具体 Tauri invoke 细节集中在 runtime 桥接层。 */
  rgSearchWorkspace?(input: {
    query: string
    path?: string
    regex?: boolean
    caseSensitive?: boolean
    globs?: string[]
    contextLines?: number
    maxMatches?: number
    workspaceRoot?: string
  }): Promise<unknown>
  /** 应用结构化 workspace patch。具体 Tauri invoke 细节集中在 runtime 桥接层。 */
  applyWorkspacePatch?(input: unknown): Promise<unknown>
  /** 写入 workspace 文本文件。具体 Tauri invoke 细节集中在 runtime 桥接层。 */
  writeWorkspaceFile?(input: unknown): Promise<unknown>
  /** 可撤回地删除 workspace 内的一个文件或目录。 */
  deleteWorkspacePath?(input: unknown): Promise<unknown>
  copyWorkspacePath?(input: unknown): Promise<unknown>
  moveWorkspacePath?(input: unknown): Promise<unknown>
  /** 回退一次由文件变更工具生成的 change set。 */
  revertWorkspaceChange?(input: unknown): Promise<unknown>
  /** 读取 git status/diff。具体 Tauri invoke 细节集中在 runtime 桥接层。 */
  getWorkspaceDiff?(input?: unknown): Promise<unknown>
  /** 运行预定义 workspace 验证任务。具体 Tauri invoke 细节集中在 runtime 桥接层。 */
  runWorkspaceTask?(input: WorkspaceTaskInput): Promise<WorkspaceTaskResult>
  /** 渲染信息卡片（browser_action 用）。harness → addBrowserCard + stale 守卫。 */
  renderCard(card: { title: string; body?: string }): { cardId: string } | { error: string }
  /** 暂存待保存文件产物（save_file 用）。harness → addPendingArtifact + stale 守卫。 */
  saveArtifact(file: { filename: string; content: string; mimeType?: string }):
    | { artifactId: string }
    | { error: string }
}

/** 统一抽象：一个工具要具备的全部。execute 同步/异步都行（工厂 await 吸收）。 */
export interface Tool {
  readonly name: string
  readonly runtime: ToolRuntime
  readonly skill: ToolSkill
  readonly inputSchema: Record<string, unknown>
  /**
   * Scheduler hint. Only tools explicitly declaring `parallel` may overlap
   * with siblings from the same model response. `effectKeys` are retained in
   * the execution graph for conflict inspection and future dependency rules.
   */
  readonly execution?: {
    readonly mode: 'serial' | 'parallel'
    readonly effectKeys?: readonly string[]
  }
  execute(args: unknown, ctx: ToolContext): ToolResult | Promise<ToolResult>
}
