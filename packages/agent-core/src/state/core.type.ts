// 核心状态的数据模型（类型）—— 从 model API 交互形状反推。配套 atom 在 sessionAtoms.ts。
// ---------------------------------------------------------------------------
// 思路：和 model 的交互形状决定了应用要存什么。
//   · 会话挂在哪个 provider 上   → ModelVendor（不透明 id，core 不解释取值）
//   · 一次请求能调哪些参数       → ModelSettings（通用参数在顶层，特化参数进设置袋）
//   · 对话历史是什么            → ConversationItem[]（从 ModelItem 推导，发请求时映射回 messages）
//   · 一轮往返后处于什么状态     → RunState（从响应 finish_reason / tool_calls 推导）
// 这里只定义数据形状；atom、会话 store 和持久化分别位于 state/runtime 对应模块。

import type { ChatRequestBase, FinishReason, ModelItem, ModelToolCall } from '@einfach-agent/ai'

// ===========================================================================
// 一、provider 身份 —— 一个不透明 id
// ===========================================================================

// 简介：当前会话用哪个 provider。
// 详情：**不透明约定** —— 取值由装配层与 agent-ai 的 provider registry 商定，core 只做相等
// 比较与查表（凭据、能力描述、档位路由表都按它索引），既不枚举合法取值，也不为任何具体取值
// 写分支。新增一家 provider 不需要改动 packages/agent-core 的任何一行。
export type ModelVendor = string

// ===========================================================================
// 二、会话级模型设置 —— 通用字段 + 供应商附加设置袋
// ===========================================================================

// 简介：一个会话当前的模型设置。
// 详情：切分判据是「会不会有第二家 provider 区别对待这个字段」——
//   · 顶层只放**跨厂商通用**且 core 自己要用的字段：vendor/model 是路由与展示的事实，
//     thinking/temperature/max_tokens 是 core 组装请求体时直接投影的通用参数；
//   · 只有某一家才认识的字段（reasoning_effort、region、baseUrl 覆盖……）一律进
//     `vendorSettings` 这个不透明袋子。core 只负责原样搬运与持久化，**不解释袋内任何 key**；
//     解释权在 agent-ai 的 adapter（见 packages/agent-ai/src/builtinProviders.ts），
//     发请求前由 runtime/modelSettingsProjection.ts 把袋子摊平交给它。
// 老会话把特化字段存在顶层，读回时由 state/persistence/settingsBagMigration.ts 收进袋子。
export type ModelSettings = {
  vendor: ModelVendor
  model: string
  thinking?: boolean
  temperature?: ChatRequestBase['temperature']
  max_tokens?: ChatRequestBase['max_tokens']
  vendorSettings?: Readonly<Record<string, unknown>>
}

// ===========================================================================
// 三、对话历史 —— 从 ModelItem 推导
// ===========================================================================

// 简介：一条对话条目 = 一条线协议 ModelItem + 状态层元信息。
// 详情：item 就是“发给 / 来自 model”的原始条目；外面包 id（稳定 key）、createdAt（排序/展示）、
// pending（assistant 仍在生成或工具结果尚未回填）。发请求时把 items 映射成 messages: ModelItem[]。
export interface ConversationItem {
  id: string
  createdAt: number
  item: ModelItem
  pending?: boolean
  /** 该条模型执行记录产生时正在运行的计划步骤；用于把思考与工具轨迹归入步骤详情。 */
  planStageId?: string
}

// ===========================================================================
// 四、run 状态机 —— 从响应 finish_reason / tool_calls 推导
// ===========================================================================

// 简介：一次 run 的状态。
// 详情：直接由响应驱动 —— finish_reason==='tool_calls' → 'awaiting_tool'（要执行工具再续）；
// ==='stop' → 'done'；'length'/异常 → 'error'；中途等用户补充 → 'waiting_user'；被打断 → 'stopped'。
// 应用重启时无法复活原网络请求，持久化中的 running/awaiting_tool 会恢复成 'interrupted'，
// 等用户显式继续；保留原 runId/turnId 以复用同一轮 checkpoint 和排队输入。
// 另有 'waiting_confirmation'：模型要调用「变更类危险工具」，执行前暂停等用户确认（S4-B，镜像 ask_user）。
export type RunStatus =
  | 'idle'
  | 'running'
  | 'awaiting_tool'
  | 'waiting_user'
  | 'waiting_confirmation'
  | 'waiting_plan_approval'
  | 'interrupted'
  | 'done'
  | 'stopped'
  | 'error'

// 简介：等待用户确认的危险工具调用（S4-B）。
// 详情：与 pendingQuestion 平行 —— tool 循环遇到危险工具时，先把同批其它 tool_call 的 result 补齐，
// 再置 waiting_confirmation + 本字段并暂停本 run（该 tool_call 的 result 留给 confirmTool 恢复时回填/执行）。
// args 是已通过 schema 校验的规范化参数；确认恢复仍会复核注册版本。
export interface PendingToolConfirmation {
  callId: string
  toolName: string
  args: unknown
  /** 注册快照版本；确认只能执行用户实际看到并批准的那一版工具。 */
  registrationVersion?: number
  /** 初次确认前已完成 schema 规范化时留下的提示，恢复后随结果回给模型。 */
  schemaWarnings?: string[]
  /** 实际 beforeToolCall hook 已放行；确认恢复不能再次触发它。 */
  beforeToolHookCompleted?: true
  risk?: 'dangerous' | 'critical'
  reason?: string
  irreversible?: boolean
}

export interface PendingPlanApproval {
  callId: string
  planId: string
  revision: number
}

export interface PendingUserDecisionOrigin {
  surface: 'conversation' | 'plan'
  phase?: 'drafting' | 'approval' | 'executing'
  planId?: string
  planRevision?: number
  stageId?: string
}

export interface PendingUserDecision {
  /** 精确对应当前尚未回填的 ask_user_question tool call。 */
  callId: string
  payload: unknown
  origin: PendingUserDecisionOrigin
}

/** A durable fact about one assistant tool call in the current run. */
export type ToolCallOutcomeState = 'notStarted' | 'outcomeKnown' | 'outcomeUnknown'

/**
 * The transcript carries tool payloads; this map only records whether their
 * external outcome is safely known. It is the canonical recovery fact.
 */
export interface ToolCallOutcomeFact {
  state: ToolCallOutcomeState
  updatedAt: number
}

/** Identifies the logical model request currently fenced by timed tool calls. */
export type TimedDispatchEpoch = number

// 简介：当前 run 的运行事实。
// 详情：finishReason 是上一轮响应的停止原因；pendingToolCalls 是 finish_reason==='tool_calls'
// 时、已从响应里校验收窄出来的待执行调用（用请求侧必填版 ModelToolCall，因为执行需要 id/name/args 齐全）。
export interface RunState {
  runId: string
  status: RunStatus
  // 用于界面展示本次连续运行的真实耗时；可选以兼容旧 checkpoint。
  startedAt?: number
  finishedAt?: number
  // 本次连续运行最初的 user item。运行中追加的排队输入不会改变该锚点，
  // 因而 checkpoint、skill 与恢复路径仍能看到本次 run 的完整 transcript。
  turnId?: string
  // status==='awaiting_tool' 时正在后台执行、且必须跟随“停止”一起取消的 execution。
  pendingExecutionId?: string
  finishReason?: FinishReason
  pendingToolCalls?: ModelToolCall[]
  /** Per-call recovery outcome facts for assistant tool calls in this run. */
  toolCallOutcomes?: Record<string, ToolCallOutcomeFact>
  /** Persisted logical request ordinal shared by timed tool phases. */
  timedDispatchEpoch?: TimedDispatchEpoch
  error?: string
  // 累计已加载 schema 的 tool 名（TK3 lazy 加载闸门累计已载）。
  loadedTools?: string[]
  // status==='waiting_user' 时挂着的 ask_user_question payload（args 原样，含 questions 数组）；
  // tool 循环内联暂停时写入，供 UI 渲染问题卡片、resume 时回填答案（形状校验留给 T-7/T-8）。
  pendingQuestion?: unknown
  // 带来源的待决策状态。pendingQuestion 暂时保留，兼容旧调用方与旧测试；新 UI/runtime 以本字段为准。
  pendingUserDecision?: PendingUserDecision
  // status==='waiting_confirmation' 时挂着的危险工具调用（S4-B）；供 UI 渲染确认卡片、
  // confirmTool 允许/拒绝时消费。与 pendingQuestion 平行。
  pendingToolConfirmation?: PendingToolConfirmation
  // create_plan 要求审批时挂起；只能由宿主 approvePlan 命令消费，模型无法自行批准。
  pendingPlanApproval?: PendingPlanApproval
}

// ===========================================================================
// 五、工作区与会话元信息
// ===========================================================================

// 简介：工作区是会话之上的一级实体；一个工作区可以包含多个会话。
// 详情：rootPath 是工具执行的目录边界，留空时仍沿用 Rust 的 git root 兜底。
export interface WorkspaceMeta {
  id: string
  name: string
  rootPath?: string
  createdAt: number
  updatedAt: number
}

// 简介：一个会话的元信息（会话是否存在的权威事实）。
// 详情：settings 决定怎么发请求；运行状态不冗存在这里，由 runBySession 的 run 决定。
export interface SessionMeta {
  id: string
  title: string
  settings: ModelSettings
  createdAt: number
  updatedAt: number
  // 会话归属的一级工作区。可选只为兼容尚未经过 hydrate 的旧数据。
  workspaceId?: string
  // 旧版把目录直接挂在会话上；新写入不再使用，仅供 hydrate/runtime 兼容读取。
  /** @deprecated 使用 WorkspaceMeta.rootPath。 */
  workspaceRoot?: string
  // 工具授权模式：confirm 保持逐次确认并把只读文件工具限制在 workspace；
  // auto 允许只读文件工具访问外部路径，且仅为极高风险调用暂停。
  // 可选以兼容旧持久化数据，读取时缺省按 confirm 处理。
  toolApprovalMode?: 'confirm' | 'auto'
  // 会话级持久化的 lazy-tool LRU（仅保存工具名，不保存可能过期的 schema）。
  // 新 run / 应用重启后会从当前 registry 重新加载这些工具的最新 schema。
  loadedTools?: string[]
}
