// tools/types.ts —— 工具统一抽象的类型（见 TOOLS-SPEC.md §2）。
// 零依赖：不 import runtime/state/UI，工具与工厂都只依赖本文件。

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

/** 懒加载后补出 schema + 指南正文（request_tool_schema 时一起给 model）。 */
export interface LoadedTool extends ToolSummary {
  inputSchema: Record<string, unknown>
  guide: string
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
 *   { ok:false, error } → JSON.stringify({ error })      —— TK6，不打断循环
 *   { pause } → 置 waiting_user，不回填该 tool（ask_user，见 §7）
 */
export type ToolResult =
  | { ok: true; data?: unknown }
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
  /** 读取 git status/diff。具体 Tauri invoke 细节集中在 runtime 桥接层。 */
  getWorkspaceDiff?(input?: unknown): Promise<unknown>
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
  execute(args: unknown, ctx: ToolContext): ToolResult | Promise<ToolResult>
}
