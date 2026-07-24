// 核心状态的数据模型（类型）—— 从 model API 交互形状反推。配套 atom 在 sessionAtoms.ts。
// ---------------------------------------------------------------------------
// 思路：和 model 的交互形状决定了应用要存什么。
//   · 我们能选哪些 provider     → ModelVendor（从 api/deepseek.ts / api/glm.ts 推导）
//   · 一次请求能调哪些参数       → ModelSettings（从 ChatRequestBase + 各家特化推导）
//   · 对话历史是什么            → ConversationItem[]（从 ModelItem 推导，发请求时映射回 messages）
//   · 一轮往返后处于什么状态     → RunState（从响应 finish_reason / tool_calls 推导）
// 这里只定义数据形状；atom、会话 store 和持久化分别位于 state/runtime 对应模块。

import type { ChatRequestBase, FinishReason, ModelItem, ModelToolCall } from '@web-agent/ai'
import type { DeepSeekReasoningEffort } from '@web-agent/ai'
import type { GlmReasoningEffort } from '@web-agent/ai'

// ===========================================================================
// 一、provider 身份 —— 从两个调用入口推导
// ===========================================================================

// 简介：当前会话用哪个 provider。
// 详情：与 api/deepseek.ts / api/glm.ts 两个 call 入口一一对应；新增 provider 时这里 + 一个文件。
export type ModelVendor = 'deepseek' | 'glm'

// ===========================================================================
// 二、会话级模型设置 —— 从请求体推导
// ===========================================================================

// 简介：两家共用的可调参数（取自 ChatRequestBase 的可配置子集）。
// 详情：model 必选；temperature / max_tokens 直接复用请求体的字段类型；thinking 在状态层
// 用 bool（发请求时再转成 { type: 'enabled' | 'disabled' }）。
interface SessionParamsBase {
  model: string
  temperature?: ChatRequestBase['temperature']
  max_tokens?: ChatRequestBase['max_tokens']
  thinking?: boolean
}

// 简介：DeepSeek 会话设置。reasoning_effort 到 'high'。
export interface DeepSeekSettings extends SessionParamsBase {
  vendor: 'deepseek'
  reasoning_effort?: DeepSeekReasoningEffort
}

// 简介：GLM 会话设置。reasoning_effort 可到 'max'。
export interface GlmSettings extends SessionParamsBase {
  vendor: 'glm'
  reasoning_effort?: GlmReasoningEffort
}

// 简介：一个会话当前的模型设置（按 vendor 判别）。
// 详情：把 API 层“参数不一样”延续到状态层 —— 按 settings.vendor 收窄后，reasoning_effort
// 的合法取值自动随之收窄（给 deepseek 设 'max' 会被 TS 拦下）。
export type ModelSettings = DeepSeekSettings | GlmSettings

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
// 另有 'waiting_confirmation'：模型要调用「变更类危险工具」，执行前暂停等用户确认（S4-B，镜像 ask_user）。
export type RunStatus =
  | 'idle'
  | 'running'
  | 'awaiting_tool'
  | 'waiting_user'
  | 'waiting_confirmation'
  | 'waiting_plan_approval'
  | 'done'
  | 'stopped'
  | 'error'

// 简介：等待用户确认的危险工具调用（S4-B）。
// 详情：与 pendingQuestion 平行 —— tool 循环遇到危险工具时，先把同批其它 tool_call 的 result 补齐，
// 再置 waiting_confirmation + 本字段并暂停本 run（该 tool_call 的 result 留给 confirmTool 恢复时回填/执行）。
// args 是模型给的原样参数（unknown），resume 允许时直接拿去执行。与 run 同为瞬态，不持久化。
export interface PendingToolConfirmation {
  callId: string
  toolName: string
  args: unknown
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
  phase?: 'drafting' | 'approval' | 'executing' | 'evaluating' | 'acceptance'
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

// 简介：当前 run 的运行事实。
// 详情：finishReason 是上一轮响应的停止原因；pendingToolCalls 是 finish_reason==='tool_calls'
// 时、已从响应里校验收窄出来的待执行调用（用请求侧必填版 ModelToolCall，因为执行需要 id/name/args 齐全）。
export interface RunState {
  runId: string
  status: RunStatus
  // status==='awaiting_tool' 时正在后台执行、且必须跟随“停止”一起取消的 execution。
  pendingExecutionId?: string
  finishReason?: FinishReason
  pendingToolCalls?: ModelToolCall[]
  error?: string
  // 累计已加载 schema 的 tool 名（TK3 lazy 加载闸门累计已载）。
  loadedTools?: string[]
  // status==='waiting_user' 时挂着的 ask_user_question payload（args 原样，含 questions 数组）；
  // tool 循环内联暂停时写入，供 UI 渲染问题卡片、resume 时回填答案（形状校验留给 T-7/T-8）。
  pendingQuestion?: unknown
  // 带来源的待决策状态。pendingQuestion 暂时保留，兼容旧调用方与旧测试；新 UI/runtime 以本字段为准。
  pendingUserDecision?: PendingUserDecision
  // status==='waiting_confirmation' 时挂着的危险工具调用（S4-B）；供 UI 渲染确认卡片、
  // confirmTool 允许/拒绝时消费。与 pendingQuestion 平行，同样不持久化。
  pendingToolConfirmation?: PendingToolConfirmation
  // create_plan 要求审批时挂起；只能由宿主 approvePlan 命令消费，模型无法自行批准。
  pendingPlanApproval?: PendingPlanApproval
}

// ===========================================================================
// 五、会话元信息 —— 会话本体（items / run 按会话分桶另存在 atom 里）
// ===========================================================================

// 简介：一个会话的元信息（会话是否存在的权威事实）。
// 详情：settings 决定怎么发请求；运行状态不冗存在这里，由 runBySession 的 run 决定。
export interface SessionMeta {
  id: string
  title: string
  settings: ModelSettings
  createdAt: number
  updatedAt: number
  // 简介：该会话绑定的 workspace 根目录（绝对路径，S4-A）。
  // 详情：server 工具（读/写/patch/git）执行时经 toolContext 透传给 Tauri 桥；未设置则不传 →
  //   Rust 侧走 git root 兜底（保持现状）。随 SessionMeta 一起持久化（sessionsPersistence）。
  //   放 SessionMeta 而非 ModelSettings —— 它不是模型请求参数，与 vendor/model 那套请求体字段无关。
  workspaceRoot?: string
  // 工具授权模式：confirm 保持逐次确认；auto 仅为极高风险调用暂停。
  // 可选以兼容旧持久化数据，读取时缺省按 confirm 处理。
  toolApprovalMode?: 'confirm' | 'auto'
  // 当前结构化计划的持久化副本；hydrate 时恢复进该会话的 planAtom。
  plan?: import('../planning/types').PlanSnapshot
  // 后台 agent/tool/plan 节点的可恢复执行图。Promise、AbortController 等
  // 进程内资源不持久化；hydrate 会把未终结节点统一转成 interrupted。
  executionGraph?: import('../execution/types').ExecutionGraphSnapshot
}
