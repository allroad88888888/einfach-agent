// tools/types.ts —— 工具统一抽象的类型（见 TOOLS-SPEC.md §2）。
// 零依赖：不 import runtime/state/UI，工具与工厂都只依赖本文件。

import type { DelegateAgentBatchResult, DelegateAgentInput } from '../runtime/delegationContract'
import type {
  CreatePlanInput,
  PlanMutationResult,
  PlanSnapshot,
  SubmitStageResultInput,
  UpdatePlanInput,
} from '../planning/types'
import type {
  ExecutionHandle,
  ExecutionJoinResult,
  ExecutionObservation,
} from '../execution/types'
import type { SkillSummary } from '../skills/contracts'
import type { ShellCommandInput, ShellCommandResult } from './shellCommandTypes'
import type { ToolCallTiming } from './toolCallTiming'
import type {
  ViewImageInput,
  ViewImageResult,
  WorkspaceImageReadInput,
  WorkspaceImageReadResult,
} from './visionToolTypes'

/**
 * tool 的执行位置：
 *   · internal —— 纯内置逻辑，任意环境可用。
 *   · browser  —— 浏览器侧副作用（渲卡片 / 存产物）。
 *   · server   —— 依赖宿主本机能力桥（hasHostBridge()，今天是 server 宿主／本机 Node 后端；
 *     T1 之前唯一来自已删除的桌面壳 Tauri）；没有桥时不可用、不进 manifest（TP3）。
 */
export type ToolRuntime = 'internal' | 'browser' | 'server'

export type { ToolCallTiming } from './toolCallTiming'
export type { ShellCommandInput, ShellCommandResult, ShellPlatform } from './shellCommandTypes'
export type {
  ViewImageCapability,
  ViewImageCapabilityContext,
  ViewImageInput,
  ViewImageResult,
  WorkspaceImageMimeType,
  WorkspaceImageReadInput,
  WorkspaceImageReadResult,
} from './visionToolTypes'

/**
 * manifest-only 摘要——model 只看这一层。description/triggers 取自 tool.skill，
 * 用于懒加载前的工具发现；不包含 inputSchema/guide（TK3/TK4）。
 */
export interface ToolSummary {
  name: string
  description: string
  triggers?: string[]
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
 * 与运行时 skill 摘要同形，工具因此自文档化。description 进 manifest；content 只经 loadSchema 给 model。
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
  | {
      ok: false
      /** Human-readable summary suitable for the model and UI. */
      error: string
      /** Stable machine-readable category used by retry/telemetry policy. */
      code?: string
      /** Optional actionable recovery guidance. */
      hint?: string
      /** Whether retrying the same operation may succeed without changing arguments. */
      retryable?: boolean
      /** Bounded structured diagnostics such as exitCode/stdout/stderr. */
      details?: unknown
    }
  | { pause: unknown }

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
  /**
   * Context-free, no-tools structured extraction on the provider's low-cost
   * lane. It is intentionally unavailable to ordinary model prompts and does
   * not create a child agent or inherit the conversation transcript.
   */
  runLowCostExtraction?(input: {
    systemPrompt: string
    userPrompt: string
    maxOutputTokens?: number
  }): Promise<{ content: string; model: string }>
  /**
   * 启动树形 headless 子 agent；由 root runtime 注入，普通工具只能经该能力派活。
   * 只有非阻塞这一条路：调用方拿到执行句柄，批次结果经 observe/join 取回。
   */
  spawnAgents?(input: DelegateAgentInput, options?: SpawnAgentsOptions): ExecutionHandle
  /** 读取后台执行节点，不等待它完成。 */
  observeExecution?(executionId: string): ExecutionObservation
  /** 显式等待后台执行节点。 */
  joinExecution?(executionId: string, timeoutMs?: number): Promise<ExecutionJoinResult>
  /** 取消一个后台执行节点。 */
  cancelExecution?(executionId: string): boolean
  /** 结构化计划能力。状态由宿主的 PlanRuntime 管理，工具不得直接访问 atom/store。 */
  getPlan?(): PlanSnapshot | undefined
  createPlan?(input: CreatePlanInput): Promise<PlanMutationResult>
  executePlan?(planId: string, revision: number): Promise<PlanMutationResult>
  updatePlan?(input: UpdatePlanInput): Promise<PlanMutationResult>
  submitStageResult?(input: SubmitStageResultInput): Promise<PlanMutationResult>
  /** 执行桌面 shell command。工具只经 ctx 调用，Tauri invoke 细节集中在 runtime 桥接层。 */
  runShell(input: ShellCommandInput): Promise<ShellCommandResult>
  /** 读取文本文件；Auto 会话可读取 workspace 外路径。具体 Tauri invoke 细节集中在 runtime 桥接层。 */
  readWorkspaceFile?(input: {
    path: string
    maxBytes?: number
    offset?: number
    workspaceRoot?: string
    allowExternalPaths?: boolean
  }): Promise<unknown>
  /** Read a bounded JPEG/PNG/WebP image through the confined host command. */
  readWorkspaceImage?(input: WorkspaceImageReadInput): Promise<WorkspaceImageReadResult>
  /** Ask an app-owned isolated vision runtime to inspect one confined workspace image. */
  viewImage?(input: ViewImageInput): Promise<ViewImageResult>
  /** 列出文件；Auto 会话可读取 workspace 外路径。具体 Tauri invoke 细节集中在 runtime 桥接层。 */
  listWorkspaceFiles?(input: {
    path?: string
    recursive?: boolean
    maxEntries?: number
    includeHidden?: boolean
    workspaceRoot?: string
    allowExternalPaths?: boolean
  }): Promise<unknown>
  /** 搜索文本文件；Auto 会话可读取 workspace 外路径。具体 Tauri invoke 细节集中在 runtime 桥接层。 */
  searchWorkspaceFiles?(input: {
    query: string
    path?: string
    glob?: string
    maxMatches?: number
    workspaceRoot?: string
    allowExternalPaths?: boolean
  }): Promise<unknown>
  /** 用 ripgrep 搜索文件；Auto 会话可搜索 workspace 外路径。具体 Tauri invoke 细节集中在 runtime 桥接层。 */
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
  /** Skill 注册表只读入口（内置 + 扫描来的）。工具缺失 ctx 时回退模块级内置 registry。 */
  skills?: {
    /** 合并内置 + 扫描（`project/` 与 `user/`）Skills 的清单。 */
    list(): SkillSummary[]
    /**
     * 解析扫描来的 skill（`project/` 或 `user/` 前缀）的读取坐标；内置名或未命中返回 undefined。
     *
     * `resources` 是扫描期发现的「资源键 → 根内相对路径」白名单：调用方只能拿键去查表，
     * 绝不能用模型给的字符串拼路径（这是 L3 资源没有穿越面的原因，Rust 侧的 workspace
     * confinement 只是兜底）。
     *
     * `rootPath` 是这两条路径相对的根：`project/` 是会话 workspace，`user/` 是主目录。
     * **读取时必须原样传给桥**——用会话 workspace 去读主目录里的 SKILL.md 会被 confinement
     * 挡下，而那时报的是「路径越界」，看上去像权限配置问题，跟真实原因（根取错了）无关。
     */
    resolveScannedSkill(name: string): {
      filePath: string
      resources: Record<string, string>
      rootPath: string
    } | undefined
  }
}

/** 统一抽象：一个工具要具备的全部。execute 同步/异步都行（工厂 await 吸收）。 */
export interface Tool {
  readonly name: string
  readonly runtime: ToolRuntime
  readonly skill: ToolSkill
  readonly inputSchema: Record<string, unknown>
  /** 缺省为 local；外部声明的工具不能声明 callTiming。 */
  readonly origin?: 'local' | 'external'
  /** 到点工具不进入模型发现面，由宿主按此值调度执行点。 */
  readonly callTiming?: ToolCallTiming
  /** Compacted results must not tell the model to repeat this effectful or costly call. */
  readonly replayUnsafe?: boolean
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
