// tools/types.ts —— 工具统一抽象的类型（见 TOOLS-SPEC.md §2）。
// 零依赖：不 import runtime/state/UI，工具与工厂都只依赖本文件。

import type { ShellCommandInput, ShellCommandResult } from './shellCommandTypes'
import type { ToolCallTiming } from './toolCallTiming'
import type { ToolContext } from './context'

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

export type { ToolContext } from './context'

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
