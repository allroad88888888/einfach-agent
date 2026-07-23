import { callDeepSeek, type DeepSeekChatRequest } from '@web-agent/ai'
import { callGlm, type GlmChatRequest } from '@web-agent/ai'
import type {
  ModelChatResponse,
  ModelFunctionTool,
  ModelItem,
  ThinkingConfig,
} from '@web-agent/ai'
import type { ModelSettings } from '../state/core.type'
import { migrateModelSettings } from '../state/persistence/modelMigration'
import { toolRegistry } from '../tools/registry'
import type { LoadedTool } from '../tools/types'
import { buildTurnTools, narrowToolCalls, parseToolCallArgs } from '../runtime/modelTurn'
import { compactContext, estimateTokensFromText } from '../runtime/contextCompaction'
import { normalizeDelegateAgentInput } from './input'
import { SubagentArchiveWriter } from './archiveWriter'
import { ROOT_AGENT_PATH, agentPathDepth } from './path'
import { subagentScheduler } from './scheduler'
import {
  canNarrowSubagentToolProfile,
  DEFAULT_SUBAGENT_TOOL_PROFILE,
  isSubagentWorkspaceReadTool,
  subagentAllowedTools,
} from './toolProfile'
import {
  renderJsonDocument,
  renderJsonLine,
  renderNodeRecord,
  renderSkillMarkdown,
  renderTreeSnapshot,
  subagentCacheBasePath,
  subagentConversationPath,
  subagentEventsPath,
  subagentIndexPath,
  subagentNodePath,
  subagentResultPath,
  subagentRunPath,
  subagentTreePath,
} from './skillCache'
import {
  distillDelegateSkills,
  formatSubagentTranscript,
  type SkillDistillChat,
} from './distill'
import type {
  ChildAgentResult,
  DelegateAgentBatchResult,
  DelegateAgentBatchStatus,
  DelegateAgentCallContext,
  DelegateAgentChildSpec,
  DelegateAgentInput,
  DelegateAgentRuntime,
  SubagentArchiveEvent,
  SubagentArchiveEventType,
  SubagentNodeRecord,
  SubagentSkillFile,
  SubagentArchiveWriteMode,
  SubagentToolProfile,
} from './types'
import { isDangerousTool } from '../runtime/dangerousTools'

const DELEGATE_TOOL_NAME = 'delegate_agent'
const DEFAULT_CHILD_MAX_TURNS = 4
const SKILL_CONTEXT_LIMIT = 18_000
// 回填给子 agent 的坏参数原文截断长度，与主循环 modelRun 的 ARGS_PREVIEW_LIMIT 对齐。
const ARGS_PREVIEW_LIMIT = 200
// 回填给父 agent 的「截断片段」预览长度：只用于定位断在哪里，不是可用产出。
const TRUNCATED_TEXT_PREVIEW_LIMIT = 200

// ---------------------------------------------------------------------------
// 子 agent 循环的上下文压缩预算（与主循环 modelRun 【故意不共用】常量）
// ---------------------------------------------------------------------------
// 为什么子 agent 需要压缩：轮数确实有硬顶（input.ts 的 HARD_MAX_TURNS=8 会 clamp 掉模型自报的
// spec.maxTurns，默认 DEFAULT_CHILD_MAX_TURNS=4），所以【轮数】撑不爆窗口；但【单轮 payload】
// 可以任意大 —— read_file 的整个文件正文、嵌套 delegate_agent 回填的完整 DelegateAgentBatchResult
// JSON 都是原样进 messages 的。深树 + 大文件场景下，4 轮就足以顶爆窗口，届时拿到的是一个硬 400
// （整个子 agent 失败、父 agent 只看到一句网络错误），而不是优雅降级。
//
// 为什么【不】复用 modelRun 的 contextWindowTokens / COST_SOFT_CAP_TOKENS(200K)：
//   · 职责不同。主循环是「一个会话一条线」，200K 软上限是给单条主线定的成本闸门；子 agent 是
//     【批量扇出】的（maxConcurrent 默认 4、maxChildren 默认 6、maxTotalNodes 默认 64），
//     按主循环的额度放行，一次 delegate 就能烧掉几十倍于主线的量。单个子 agent 吃掉巨量上下文
//     这件事本身就不合理 —— 它拿到的是一个被 distill 过的窄任务，不是整段会话史。
//   · 一个子 agent 真需要 200K 上下文，正确的修法是让父 agent 把任务拆细，而不是抬预算。
// 60K 的定法：取「全仓最保守的真实窗口」之下的安全值 —— modelRun 窗口表里最小的一档是 128K
// （glm-4.5-air / 4-flash 系），未知模型的 vendor 兜底是 64K。60K 总预算扣掉预留后实际生效约
// 47K，即使模型名拼错走到 64K 兜底也不会撞墙。同时它容得下 4 轮各约 12K token 的工具正文
// （≈ 每轮一个 45KB 源文件），正常子任务根本压不到，只有真的超量才降级。
const SUBAGENT_CONTEXT_BUDGET_TOKENS = 60_000
// settings.max_tokens 未设时给子 agent 输出预留的额度。
const SUBAGENT_RESERVED_OUTPUT_TOKENS = 8_000
// 安全余量比例，口径同主循环：本地估算对 tool_calls 的 JSON 结构偏乐观，留一档。
const SUBAGENT_CONTEXT_SAFETY_MARGIN_RATIO = 0.08
// 子 agent 的消息序列里【只有一条 user】（childUserPrompt），所以 compactContext 的
// protectedStartIndex 恒等于那条 user 的下标，keepRecentTurns 取多少都不改变分级结果：
// L1~L3（丢弃历史）永远无事可做，实际生效的只有 L4（摘要 tool 结果正文、不丢弃任何条目）。
// 这正是子 agent 想要的形状 —— 从最老的 tool 组开始摘要，压到刚好达标就停手，
// 且因为【一条都不丢】，assistant.tool_calls ↔ tool_call_id 的配对天然不可能出孤儿。
// 显式写 1 是为了让这个「无论如何都不丢历史」的意图留在代码里，而不是靠默认值巧合成立。
const SUBAGENT_KEEP_RECENT_TURNS = 1

// finish_reason 异常三态在子 agent 语境下的文案。
// 三种成因语义不同，父 agent 的应对也不同（缩小任务 / 换表述 / 稍后重试），所以必须分别写清；
// 混成一句笼统的「子 agent 失败」会让父 agent 无从判断该怎么补救。
// 与主循环 modelRun 的 FINISH_REASON_ERRORS 同口径，但主语换成子 agent —— 这份文案最终是写进
// ChildAgentResult.error/summary 回填给父 agent 的，不是给终端用户看的 run 状态。
const SUBAGENT_FINISH_REASON_ERRORS: Record<
  'length' | 'content_filter' | 'insufficient_system_resource',
  string
> = {
  length:
    '子 agent 输出触顶被截断（finish_reason=length），本次产出不完整、不可作为结论采用；请缩小子任务范围或调高 max_tokens 后重试',
  content_filter:
    '子 agent 输出被内容安全策略拦截（finish_reason=content_filter），本次没有可用产出；请调整子任务表述后重试',
  insufficient_system_resource:
    '子 agent 所用模型服务容量不足（finish_reason=insufficient_system_resource），本次没有产出；请稍后重试',
}

function isAbnormalFinishReason(
  value: unknown,
): value is 'length' | 'content_filter' | 'insufficient_system_resource' {
  return value === 'length' || value === 'content_filter' || value === 'insufficient_system_resource'
}

// ---------------------------------------------------------------------------
// 子 agent 上下文压缩的归档事件类型与主循环 modelRun 的 trace 事件一一对应：
//   'child_context_compacted'   ↔ 'llm.context_compacted'
//   'child_context_over_budget' ↔ 'llm.context_over_budget'
// 两者都已进 types.ts 的 SubagentArchiveEventType 联合与 replay.ts 的 SUBAGENT_EVENT_TYPES
// 白名单（两处必须同步，漏一个 replay 就会把该事件判为结构非法丢进 parseErrors）。

// 简介：callModel 的可观测性上下文（可选）。
// 详情：recordEvent 需要 DelegateAgentCallContext + archiveBasePath 才能落盘，callModel 原本
//   两样都拿不到。绑成一个可选对象而不是三个散参数，是为了让「传了 context 却漏传 archiveBasePath」
//   在类型层就不可能发生。
interface CallModelObservation {
  context: DelegateAgentCallContext
  archiveBasePath: string
  agentPath: string
  // 第几轮（1-based）。同一个子 agent 的多轮压缩事件靠它区分。
  // distill 不是「轮」——它是一次性的蒸馏调用，用 phase:'distill' 标识，turn 恒为 0。
  turn: number
  // 哪个阶段发起的调用。省略 = 子 agent 的工具循环轮次（绝大多数情况）。
  // 'distill' 单列出来，是因为它超预算的成因和补救方式都不同：不是「子 agent 干太多活」，
  // 而是「父 agent 的 transcript 或继承的 skill 正文太长」，排查者据此才知道该去缩哪一头。
  phase?: 'distill'
}

function truncatedTextPreview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  return flat.length > TRUNCATED_TEXT_PREVIEW_LIMIT
    ? `${flat.slice(0, TRUNCATED_TEXT_PREVIEW_LIMIT)}...`
    : flat
}

interface TreeRuntimeBudget {
  maxDepth: number
  maxChildren: number
  maxConcurrent: number
  maxTotalNodes: number
  maxModelCalls: number
}

class ModelCallSemaphore {
  private active = 0
  private readonly waiters: Array<() => void> = []

  constructor(private readonly limit: number) {}

  async run<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    await this.acquire(signal)
    try {
      return await task()
    } finally {
      this.release()
    }
  }

  private acquire(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
    if (this.active < this.limit) {
      this.active += 1
      return Promise.resolve()
    }

    return new Promise<void>((resolve, reject) => {
      const wake = () => {
        signal.removeEventListener('abort', onAbort)
        this.active += 1
        resolve()
      }
      const onAbort = () => {
        const index = this.waiters.indexOf(wake)
        if (index >= 0) this.waiters.splice(index, 1)
        reject(new DOMException('Aborted', 'AbortError'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(wake)
    })
  }

  private release(): void {
    this.active -= 1
    this.waiters.shift()?.()
  }
}

interface CreateDelegateAgentRuntimeOptions {
  sessionId: string
  runId: string
  settings: ModelSettings
  apiKey: string
  signal: AbortSignal
  fetchImpl?: typeof fetch
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name
  if (typeof error === 'string') return error
  return 'unknown error'
}

function isAbortError(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === 'AbortError')
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function argsPreviewForModel(raw: string): string {
  return raw.length > ARGS_PREVIEW_LIMIT ? `${raw.slice(0, ARGS_PREVIEW_LIMIT)}...` : raw
}

function thinkingConfig(settings: ModelSettings): ThinkingConfig | undefined {
  if (settings.thinking === undefined) return undefined
  return { type: settings.thinking ? 'enabled' : 'disabled' }
}

function firstAssistantText(response: ModelChatResponse): string {
  const content = response.choices?.[0]?.message?.content
  return typeof content === 'string' ? content.trim() : ''
}

function appendVisibleTool(current: LoadedTool[], name: string): LoadedTool[] {
  if (current.some((tool) => tool.name === name)) return current
  const tool = toolRegistry.loadSchema(name)
  return tool ? [...current, tool] : current
}

function renderSkillsForPrompt(skills: SubagentSkillFile[]): string {
  const body = skills
    .map((skill) => [`# ${skill.filename}`, skill.content.trim()].join('\n\n'))
    .join('\n\n---\n\n')
  return body.length > SKILL_CONTEXT_LIMIT ? `${body.slice(0, SKILL_CONTEXT_LIMIT)}\n...[truncated]` : body
}

function compactIndexText(value: string, limit = 500): string {
  const trimmed = value.replace(/\s+/g, ' ').trim()
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}...[truncated]` : trimmed
}

function skillIndexRecord(skill: SubagentSkillFile): Record<string, unknown> {
  return {
    type: 'skill',
    skillId: skill.skillId,
    conversationId: skill.conversationId,
    runId: skill.runId,
    agentPath: skill.agentPath,
    kind: skill.kind,
    filename: skill.filename,
    path: skill.path,
    globalPath: skill.globalPath,
    contentHash: skill.contentHash,
    promotion: skill.promotion,
    ttl: skill.ttl,
    inheritSkillIds: skill.inheritSkillIds,
    sourceTranscriptChars: skill.source.transcriptChars,
    createdAt: skill.createdAt,
    summary: compactIndexText(skill.content),
  }
}

function nodeIndexRecord(node: SubagentNodeRecord): Record<string, unknown> {
  return {
    type: 'agent_node',
    id: node.id,
    conversationId: node.sessionId,
    runId: node.treeId,
    path: node.path,
    parentPath: node.parentPath,
    status: node.status,
    objective: node.objective,
    depth: node.depth,
    inheritedSkillIds: node.inheritedSkillIds,
    localSkillIds: node.localSkillIds,
    resultFile: node.resultFile,
    error: node.error,
    updatedAt: node.updatedAt,
  }
}

function childSystemPrompt(args: {
  node: SubagentNodeRecord
  inheritedSkills: SubagentSkillFile[]
  localSkill: SubagentSkillFile
  toolProfile: SubagentToolProfile
  confirmedTools: readonly string[]
}): string {
  const skills = renderSkillsForPrompt([...args.inheritedSkills, args.localSkill])
  return [
    `你是树形子 agent ${args.node.path}。`,
    `父 agent: ${args.node.parentPath ?? ROOT_AGENT_PATH}`,
    '你在 headless 子 agent 运行时中工作：不要要求 UI 暂停；需要更多并行分析时，可以调用 delegate_agent 派生下一层子 agent。',
    args.toolProfile === 'workspace_read'
      ? '允许 delegate_agent 和只读 workspace 工具；不得声称或尝试写文件、执行 shell。'
      : '只允许 delegate_agent；不要模拟工具调用，不要声称已经改文件。',
    args.confirmedTools.length > 0
      ? `本次委派另有父级已确认、仅限本 run 的危险工具能力: ${args.confirmedTools.join(', ')}。不得请求其它危险工具，也不得向后代扩大范围。`
      : '没有危险工具能力；不得请求写文件、patch 或 shell。',
    '最终输出必须是可回填给父 agent 的简洁 Markdown：结论、发现、风险、建议下一步。',
    '',
    '继承的临时 skills:',
    skills,
  ].join('\n')
}

function childSummary(children: readonly ChildAgentResult[]): DelegateAgentBatchResult['summary'] {
  return {
    total: children.length,
    done: children.filter((child) => child.status === 'done').length,
    failed: children.filter((child) => child.status === 'failed').length,
    cancelled: children.filter((child) => child.status === 'cancelled').length,
  }
}

function batchStatus(
  strategy: DelegateAgentInput['strategy'],
  summary: DelegateAgentBatchResult['summary'],
): DelegateAgentBatchStatus {
  if (summary.cancelled > 0) return 'cancelled'
  if (summary.failed === 0) return 'done'
  if (strategy === 'parallel_best_effort' && summary.done > 0) return 'partial'
  return 'failed'
}

function isSubset(requested: readonly string[], ceiling: readonly string[]): boolean {
  return requested.every((name) => ceiling.includes(name))
}

function childUserPrompt(spec: DelegateAgentChildSpec): string {
  return [
    `任务目标: ${spec.objective}`,
    spec.mode ? `模式: ${spec.mode}` : '',
    spec.expectedOutput ? `期望输出: ${spec.expectedOutput}` : '',
    '',
    '请完成任务；如果需要拆分并行工作，调用 delegate_agent。',
  ]
    .filter(Boolean)
    .join('\n')
}

async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  maxConcurrent: number,
): Promise<T[]> {
  const results: T[] = []
  let nextIndex = 0

  async function worker(): Promise<void> {
    for (;;) {
      const index = nextIndex
      nextIndex += 1
      if (index >= tasks.length) return
      results[index] = await tasks[index]()
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(maxConcurrent, tasks.length)) }, () => worker())
  await Promise.all(workers)
  return results
}

export function createDelegateAgentRuntime(
  rawOpts: CreateDelegateAgentRuntimeOptions,
): DelegateAgentRuntime {
  // 请求路径兜底（同 modelRun）：子 agent 用父会话的 settings 发请求，父会话若带着下线模型名，
  // 扇出的【每个】子 agent 都会撞 400。在这里整体迁移一次（连带 thinking），下游 opts.settings.*
  // 全部读到迁移后的值。无需迁移时返回同一引用，opts === rawOpts，零额外开销。
  const migratedSettings = migrateModelSettings(rawOpts.settings)
  const opts: CreateDelegateAgentRuntimeOptions =
    migratedSettings === rawOpts.settings ? rawOpts : { ...rawOpts, settings: migratedSettings }
  let archiveInitialized = false
  let archiveInitialization: Promise<void> | undefined
  let eventCounter = 0
  const archiveStartedAt = new Date().toISOString()
  let rootBudget: TreeRuntimeBudget | undefined
  let rootToolProfile: SubagentToolProfile | undefined
  let modelCallSemaphore: ModelCallSemaphore | undefined
  let totalNodesUsed = 1
  let modelCallsUsed = 0
  const budgetByPath = new Map<string, TreeRuntimeBudget>()
  const toolProfileByPath = new Map<string, SubagentToolProfile>()
  const confirmedToolsByPath = new Map<string, readonly string[]>()
  const archiveWriter = new SubagentArchiveWriter()
  const batchedIndexPaths = new Set([
    subagentIndexPath('runs'),
    subagentIndexPath('skills'),
    subagentIndexPath('agents'),
  ])

  function reserveNodes(count: number, limit: number): void {
    const effectiveLimit = Math.min(rootBudget?.maxTotalNodes ?? limit, limit)
    const remaining = Math.max(0, effectiveLimit - totalNodesUsed)
    if (count > remaining) {
      throw new Error(
        `subagent tree node budget exhausted: requested ${count}, remaining ${remaining}, used ${totalNodesUsed} of ${effectiveLimit}`,
      )
    }
    totalNodesUsed += count
  }

  function reserveModelCall(limit: number): void {
    const effectiveLimit = Math.min(rootBudget?.maxModelCalls ?? limit, limit)
    if (modelCallsUsed >= effectiveLimit) {
      throw new Error(
        `subagent tree model-call budget exhausted: used ${modelCallsUsed} of ${effectiveLimit}`,
      )
    }
    modelCallsUsed += 1
  }

  function budgetUsage(): DelegateAgentBatchResult['budgetUsage'] {
    return {
      totalNodes: {
        used: totalNodesUsed,
        limit: rootBudget?.maxTotalNodes ?? totalNodesUsed,
      },
      modelCalls: {
        used: modelCallsUsed,
        limit: rootBudget?.maxModelCalls ?? modelCallsUsed,
      },
    }
  }

  async function callModel(args: {
    messages: ModelItem[]
    tools?: ModelFunctionTool[]
    toolChoice?: 'auto' | 'none'
    // 可观测性上下文。不传 = 本次调用不记压缩事件（见下方 distillChat 的说明）。
    observe?: CallModelObservation
  }, maxModelCalls?: number): Promise<ModelChatResponse> {
    const modelCallLimit = maxModelCalls ?? rootBudget?.maxModelCalls ?? 128

    // ── CC 接入（子 agent 循环）。
    // ★ 压缩【只发生在这里、结果只进请求体】★ —— runChildAgent 里那个 messages 数组是子 agent
    //   的唯一真相源，它同时喂三处：下一轮请求、嵌套 delegate 的 formatSubagentTranscript(messages)
    //   （distill 的输入，会被写成继承给后代的 skill 正文）、以及归档。把摘要写回去会三处一起烂：
    //   子 agent 后续轮次基于被摘要的历史继续推理、后代继承到失真的 brief、replay 出来的东西和
    //   真实跑过的对不上。所以接入点【必须】在 callModel 内部对入参做一次性投影 ——
    //   compactContext 是纯函数、从不改写入参（未超预算时直接返回同一引用），调用方无从被污染。
    // 顺带说明 distillChat：它也走 callModel，但消息只有 [system, user] 且没有任何 tool 条目，
    //   两条都在 compactContext 的硬保护范围内，L4 也无 tool 正文可摘 —— 压缩【行为】上必然是
    //   no-op，不需要为它特判；它唯一的差别在可观测性（不传 observe，见 distillChat 处的说明）。
    // tools manifest 的 JSON 同样吃额度，先从预算里扣掉。
    const reservedTokens =
      estimateTokensFromText(JSON.stringify(args.tools ?? [])) +
      (opts.settings.max_tokens ?? SUBAGENT_RESERVED_OUTPUT_TOKENS) +
      Math.ceil(SUBAGENT_CONTEXT_BUDGET_TOKENS * SUBAGENT_CONTEXT_SAFETY_MARGIN_RATIO)
    const compaction = compactContext(args.messages, {
      maxTokens: SUBAGENT_CONTEXT_BUDGET_TOKENS,
      reservedTokens,
      keepRecentTurns: SUBAGENT_KEEP_RECENT_TURNS,
    })

    // ── 压缩的可观测性。
    // 压缩本身是「悄悄降级」：子 agent 之后可能说「我需要重新读一下那个文件」，或交出一份基于
    // 残缺上下文的 result.md。没有这两条事件，父 agent / 树面板 / trace / 归档【没有任何一处】
    // 能看出它的上下文被压过，排查者只会怀疑模型变笨了。
    //
    // ★ 全部走 bestEffortRecordEvent、绝不用 recordEvent ★ —— 二者的差别就是后者会把写盘异常
    //   抛给调用方。这里的调用方是 callModel，异常会一路冒到 runChildAgent 的 catch，把子 agent
    //   标成 failed。即：宿主取消/归档不可写时，一条「记日志失败」会伪装成「子 agent 失败」。
    //   可观测性代码永远不该有能力让被观测的东西失败。
    //
    // ★ 两个 if 相互独立、不是 else 分支 ★ —— compacted 与 withinBudget 没有蕴含关系：
    //   messages 只有 [system, user]（两条都在硬保护范围内）或全部 tool 正文都短到压不动时，
    //   compactContext 会返回 compacted:false + withinBudget:false。把 over_budget 挂在
    //   compacted 里面，恰好会漏掉「压根压不动、必然撞 400」这个最该报警的形态。
    if (args.observe) {
      const { context, archiveBasePath, agentPath, turn } = args.observe
      if (compaction.compacted) {
        // 字段口径对齐主循环 modelRun 的 'llm.context_compacted'（便于两侧交叉对照）。
        // ★ key 里避开 "token" 子串、改用 Tk 后缀 ★：observability/redact.ts 的 SENSITIVE_KEY
        //   是子串匹配且含 |token|，命中的 key 会被整个抹成 '[REDACTED]'。归档目前不过那条
        //   脱敏管道，但指标名一旦定死就会被复制到别处，先按安全形态定名。
        await bestEffortRecordEvent(context, archiveBasePath, 'child_context_compacted', agentPath, {
          turn,
          budgetTk: SUBAGENT_CONTEXT_BUDGET_TOKENS,
          reservedTk: reservedTokens,
          effectiveBudgetTk: compaction.effectiveBudgetTokens,
          estBeforeTk: compaction.estimatedTokensBefore,
          estAfterTk: compaction.estimatedTokensAfter,
          summarizedToolResults: compaction.summarizedToolResults,
          droppedItems: compaction.droppedItems,
          messagesBefore: args.messages.length,
          messagesAfter: compaction.items.length,
          withinBudget: compaction.withinBudget,
        })
      }
      // 四级降级跑完仍超预算：请求【照发不误】（序列仍然合法，不因此中止子 agent），但必须留痕。
      // 这条链路大概率换来一个硬 400，而那个 400 与「压缩根本没生效」在日志里长得一模一样 ——
      // 有了这条事件才能区分「尽力了但不够」和「压缩没跑」。
      if (!compaction.withinBudget) {
        await bestEffortRecordEvent(context, archiveBasePath, 'child_context_over_budget', agentPath, {
          turn,
          ...(args.observe.phase ? { phase: args.observe.phase } : {}),
          effectiveBudgetTk: compaction.effectiveBudgetTokens,
          estAfterTk: compaction.estimatedTokensAfter,
          compacted: compaction.compacted,
          hint: compaction.compacted
            ? '子 agent 上下文压缩后仍超预算（多半是单条工具正文自己就撑爆了预算），本次请求可能被接口拒绝；请缩小子任务范围或让工具只取所需片段'
            : '子 agent 上下文超预算且无可压缩内容（system/user 均在硬保护范围内），本次请求可能被接口拒绝；请缩短子任务描述或继承的 skill 正文',
        })
      }
    }

    const requestBase = {
      model: opts.settings.model,
      messages: compaction.items,
      temperature: opts.settings.temperature,
      max_tokens: opts.settings.max_tokens,
      thinking: thinkingConfig(opts.settings),
      tools: args.tools,
      tool_choice: args.toolChoice ?? 'auto',
      stream: false,
    }
    const callOptions = { apiKey: opts.apiKey, signal: opts.signal, fetchImpl: opts.fetchImpl }

    const invoke = () => {
      reserveModelCall(modelCallLimit)
      if (opts.settings.vendor === 'glm') {
        const body: GlmChatRequest = {
          ...requestBase,
          reasoning_effort: opts.settings.reasoning_effort,
        }
        return callGlm(body, callOptions)
      }

      const body: DeepSeekChatRequest = {
        ...requestBase,
        reasoning_effort: opts.settings.reasoning_effort,
      }
      return callDeepSeek(body, callOptions)
    }
    return modelCallSemaphore ? modelCallSemaphore.run(opts.signal, invoke) : invoke()
  }

  const distillChat = async (
    input: Parameters<SkillDistillChat>[0],
    maxModelCalls: number,
    observe?: CallModelObservation,
  ) => {
    // 蒸馏的消息只有 [system, user]、无任何 tool 条目，两条都在 compactContext 的硬保护范围内，
    // L1~L4 无一有事可做 —— 'child_context_compacted' 结构上永远不会触发。
    // 但 'child_context_over_budget' 在这条路上【是会发生的】：distill 的 user 正文含整份
    // parentTranscript，深树 + 长对话下它自己就能超预算，而这里压不动、只能原样发出去撞 400。
    // 那是最该报警的形态之一（压根压不动），所以 observe 要传 —— 只是它带 phase:'distill'，
    // 好让排查者知道该缩的是父 agent 的 transcript / 继承 skill，而不是子 agent 的工具输出。
    const response = await callModel({
      messages: [
        { role: 'system', content: input.system },
        { role: 'user', content: input.user },
      ],
      toolChoice: 'none',
      observe,
    }, maxModelCalls)
    const text = firstAssistantText(response)
    const base = text || `# ${input.purpose}\n\nNo distilled content returned.`
    // 蒸馏出来的 skill 正文会被写进子孙 agent 的 system prompt 并一路继承下去。若这次蒸馏本身
    // 触顶/被拦截，半截 brief 原样下发就等于让后代把「不完整的约束」当成完整约束执行。
    // 这里【不】throw：throw 会让 distillDelegateSkills 整批失败（parallel_wait_all 下直接废掉
    // 本次 delegate），代价远大于问题本身。改成把「本 skill 不完整」写进正文 ——
    // 截断信息因此不会在 distill 链路里丢失，继承它的 agent 自己看得见。
    const finishReason = response.choices?.[0]?.finish_reason ?? null
    if (!isAbnormalFinishReason(finishReason)) return base
    return [
      base,
      '',
      `> ${SUBAGENT_FINISH_REASON_ERRORS[finishReason]}`,
      '> 本 skill 内容不完整，不得当作完整约束执行；缺失部分请回到父 agent 澄清后再动手。',
    ].join('\n')
  }

  async function writeText(
    context: DelegateAgentCallContext,
    path: string,
    content: string,
    mode: SubagentArchiveWriteMode = 'overwrite',
  ): Promise<void> {
    if (!context.writeTextFile) return
    await archiveWriter.write(
      { path, content, mode },
      async (input) => {
        const result = await context.writeTextFile!(input)
        if (result && typeof result === 'object' && 'ok' in result && result.ok === false) {
          const error = 'error' in result ? String(result.error) : 'unknown write error'
          throw new Error(`failed to write subagent archive ${input.path}: ${error}`)
        }
      },
      { batchAppend: mode === 'append' && batchedIndexPaths.has(path) },
    )
  }

  function runArchiveRecord(
    archiveBasePath: string,
    status: 'running' | 'delegated',
  ): Record<string, unknown> {
    return {
      archiveVersion: 1,
      conversationId: opts.sessionId,
      runId: opts.runId,
      treeId: opts.runId,
      status,
      model: opts.settings.model,
      vendor: opts.settings.vendor,
      archiveBasePath,
      eventLog: subagentEventsPath(archiveBasePath),
      startedAt: archiveStartedAt,
      updatedAt: new Date().toISOString(),
    }
  }

  async function writeRunArchiveRecord(
    context: DelegateAgentCallContext,
    archiveBasePath: string,
    status: 'running' | 'delegated',
    appendIndex: boolean,
  ): Promise<void> {
    const record = runArchiveRecord(archiveBasePath, status)
    await writeText(context, subagentRunPath(archiveBasePath), renderJsonDocument(record))
    if (appendIndex) {
      await writeText(context, subagentIndexPath('runs'), renderJsonLine(record), 'append')
    }
  }

  async function ensureArchiveInitialized(
    context: DelegateAgentCallContext,
    archiveBasePath: string,
  ): Promise<void> {
    if (archiveInitialized) return
    if (!archiveInitialization) {
      archiveInitialization = (async () => {
        const now = new Date().toISOString()
        await Promise.all([
          writeText(
            context,
            subagentConversationPath(opts.sessionId),
            renderJsonDocument({
              archiveVersion: 1,
              conversationId: opts.sessionId,
              updatedAt: now,
            }),
          ),
          writeRunArchiveRecord(context, archiveBasePath, 'running', true),
        ])
        await recordEvent(context, archiveBasePath, 'archive_initialized', ROOT_AGENT_PATH, {
          archiveBasePath,
          eventLog: subagentEventsPath(archiveBasePath),
        })
        archiveInitialized = true
      })()
    }
    try {
      await archiveInitialization
    } finally {
      if (!archiveInitialized) archiveInitialization = undefined
    }
  }

  async function recordEvent(
    context: DelegateAgentCallContext,
    archiveBasePath: string,
    type: SubagentArchiveEventType,
    agentPath: string,
    data?: Record<string, unknown>,
  ): Promise<void> {
    eventCounter += 1
    const event: SubagentArchiveEvent = {
      eventId: `${opts.runId}:evt-${String(eventCounter).padStart(4, '0')}`,
      type,
      timestamp: new Date().toISOString(),
      conversationId: opts.sessionId,
      runId: opts.runId,
      treeId: opts.runId,
      agentPath,
      data,
    }
    await writeText(context, subagentEventsPath(archiveBasePath), renderJsonLine(event), 'append')
  }

  async function bestEffortRecordEvent(
    context: DelegateAgentCallContext,
    archiveBasePath: string,
    type: SubagentArchiveEventType,
    agentPath: string,
    data?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await recordEvent(context, archiveBasePath, type, agentPath, data)
    } catch {
      // A cancelled/stale host may reject archive writes. Preserve the original runtime outcome.
    }
  }

  async function persistSkill(
    context: DelegateAgentCallContext,
    archiveBasePath: string,
    skill: SubagentSkillFile,
  ): Promise<void> {
    const content = renderSkillMarkdown(skill)
    await Promise.all([
      writeText(context, skill.path, content),
      writeText(context, skill.globalPath, content),
      writeText(context, subagentIndexPath('skills'), renderJsonLine(skillIndexRecord(skill)), 'append'),
    ])
    await recordEvent(context, archiveBasePath, 'skill_written', skill.agentPath, {
      skillId: skill.skillId,
      kind: skill.kind,
      path: skill.path,
      globalPath: skill.globalPath,
      contentHash: skill.contentHash,
      promotion: skill.promotion,
    })
  }

  async function persistTreeSnapshot(
    context: DelegateAgentCallContext,
    archiveBasePath: string,
    nodes: SubagentNodeRecord[],
  ): Promise<void> {
    await writeText(context, subagentTreePath(archiveBasePath), renderTreeSnapshot(nodes))
    await Promise.all(
      nodes.map((node) => writeText(context, subagentNodePath(archiveBasePath, node.path), renderNodeRecord(node))),
    )
    await Promise.all(
      nodes.map((node) => writeText(context, subagentIndexPath('agents'), renderJsonLine(nodeIndexRecord(node)), 'append')),
    )
    await recordEvent(context, archiveBasePath, 'tree_snapshot_written', ROOT_AGENT_PATH, {
      nodes: nodes.length,
      treePath: subagentTreePath(archiveBasePath),
    })
  }

  async function runChildAgent(args: {
    node: SubagentNodeRecord
    spec: DelegateAgentChildSpec
    context: DelegateAgentCallContext
    archiveBasePath: string
    inheritedSkills: SubagentSkillFile[]
    localSkill: SubagentSkillFile
    budget: TreeRuntimeBudget
    toolProfile: SubagentToolProfile
    confirmedTools: readonly string[]
  }): Promise<ChildAgentResult> {
    const { node, spec, context, archiveBasePath, inheritedSkills, localSkill, budget, toolProfile, confirmedTools } = args
    const allowedToolNames = [...subagentAllowedTools(toolProfile), ...confirmedTools]
    const skillFiles = [...node.inheritedSkillFiles, localSkill.path]
    const skillIds = [...node.inheritedSkillIds, localSkill.skillId]
    subagentScheduler.markNode(opts.runId, node.path, 'running', {
      localSkillFiles: [localSkill.path],
      localSkillIds: [localSkill.skillId],
      inheritedSkillFiles: [...node.inheritedSkillFiles],
      inheritedSkillIds: [...node.inheritedSkillIds],
    })
    await recordEvent(context, archiveBasePath, 'child_started', node.path, {
      objective: spec.objective,
      mode: spec.mode,
      toolProfile,
      confirmedTools,
      skillId: localSkill.skillId,
      inheritedSkillIds: node.inheritedSkillIds,
    })

    const messages: ModelItem[] = [
      {
        role: 'system',
        content: childSystemPrompt({ node, inheritedSkills, localSkill, toolProfile, confirmedTools }),
      },
      { role: 'user', content: childUserPrompt(spec) },
    ]
    let visible: LoadedTool[] = []
    const maxTurns = spec.maxTurns ?? DEFAULT_CHILD_MAX_TURNS

    try {
      for (let turn = 0; turn < maxTurns; turn += 1) {
        const tools = buildTurnTools(visible, true, { allowedToolNames })
        const response = await callModel(
          {
            messages,
            tools,
            toolChoice: 'auto',
            observe: { context, archiveBasePath, agentPath: node.path, turn: turn + 1 },
          },
          budget.maxModelCalls,
        )
        const msg = response.choices?.[0]?.message
        const toolCalls = narrowToolCalls(msg?.tool_calls)

        // ── finish_reason 异常三态分流。
        // ★ 必须在下面 toolCalls.length === 0 的收尾路径【之前】★ —— 那条路会把 content 原样写进
        //   result.md 并把节点 markNode 成 'done'。finish_reason='length' 时 content 是半截文本，
        //   于是一个残缺答案以「成功」身份回填给父 agent；content_filter / insufficient_system_resource
        //   时 content 为空，落到 '子 agent 未返回有效文本。' 兜底文案，同样被标成 'done'。
        //   父 agent 和兄弟 agent 都无从知道这份结论是残缺的，还会经 distill 传给后代 —— distill 的
        //   输入正是父 agent 的消息序列（formatSubagentTranscript(messages)），一个 'done' 的半截
        //   结论会被当作既成事实继承下去。这是本文件最隐蔽的一类污染。
        const finishReason = response.choices?.[0]?.finish_reason ?? null
        // 触顶【且】带 tool_calls 是唯一的豁免：arguments 多半是半截 JSON，交给下面每个 tool_call
        // 的 parseToolCallArgs 闸门 —— 它会回填一条说明 JSON 坏了的 tool 结果，消息序列保持合法，
        // 子 agent 还能重发一次完整调用。在这里终止反而会废掉那道闸门，
        // 把「可恢复的一轮」变成「整个子 agent 失败」。
        const recoverableTruncatedToolCall = finishReason === 'length' && toolCalls.length > 0
        if (!recoverableTruncatedToolCall && isAbnormalFinishReason(finishReason)) {
          // 走本函数【既有的】catch 分支：markNode 成 'failed'，并把原因写进
          // ChildAgentResult.error / summary 回填给父 agent。
          // 之所以用 failed 而不是新造一个 'truncated' 状态：ChildAgentResult.status 与
          // SubagentNodeStatus 的取值集合是全仓共享的契约（childSummary / batchStatus / 树快照 /
          // replay 都按这三态消费），而「产出不可信」在语义上就等同于本次子 agent 没有交付；
          // failed 已经能让 parallel_best_effort 降级成 partial、parallel_wait_all 整批失败，
          // 精确成因由这段中文错误文案承载，父 agent 读得到、也读得懂。
          // 截断的正文【要留住】，别只留 200 字符预览就丢掉：一个跑了几轮、产出几千字结论、
          // 只在最后一句被掐断的子 agent，那部分工作仍然有效，父 agent 应当能复用而不是整体重跑。
          // 这与主循环对 length 的处置对齐（modelRun 把截断正文连同标注一起落盘）。
          // 落 result.partial.md 而非 result.md：后者是「可信产出」的位置，markNode 也不会
          // 把它登记成 resultFile —— 状态仍是 failed，父 agent 必须显式决定要不要采信这份残稿。
          const fullText = finishReason === 'length' ? firstAssistantText(response) : ''
          let partialPath = ''
          if (fullText) {
            const candidate = subagentResultPath(archiveBasePath, node.path).replace(
              /\.md$/,
              '.partial.md',
            )
            // best-effort：归档写失败不该把「截断」这个真正的失败原因替换成一个写盘错误。
            try {
              await writeText(context, candidate, `${fullText.trim()}\n`)
              partialPath = candidate
            } catch {
              partialPath = ''
            }
          }
          const preview = truncatedTextPreview(fullText)
          const detail = [
            preview ? `截断片段（仅供定位，不完整）: ${preview}` : '',
            partialPath ? `完整残稿已存至 ${partialPath}（未经校验，采信前请自行判断）` : '',
          ]
            .filter(Boolean)
            .join('；')
          throw new Error(
            detail
              ? `${SUBAGENT_FINISH_REASON_ERRORS[finishReason]}；${detail}`
              : SUBAGENT_FINISH_REASON_ERRORS[finishReason],
          )
        }

        if (toolCalls.length === 0) {
          const summary = firstAssistantText(response) || '子 agent 未返回有效文本。'
          const resultPath = subagentResultPath(archiveBasePath, node.path)
          await writeText(context, resultPath, `${summary.trim()}\n`)
          subagentScheduler.markNode(opts.runId, node.path, 'done', {
            resultFile: resultPath,
            localSkillFiles: [localSkill.path],
            localSkillIds: [localSkill.skillId],
            inheritedSkillFiles: [...node.inheritedSkillFiles],
            inheritedSkillIds: [...node.inheritedSkillIds],
          })
          await recordEvent(context, archiveBasePath, 'child_finished', node.path, {
            status: 'done',
            objective: spec.objective,
            summary,
            resultFile: resultPath,
            skillFiles,
            skillIds,
          })
          return {
            path: node.path,
            status: 'done',
            objective: spec.objective,
            summary,
            resultFile: resultPath,
            skillFiles,
            skillIds,
          }
        }

        messages.push({
          role: 'assistant',
          content: typeof msg?.content === 'string' ? msg.content : null,
          reasoning_content: msg?.reasoning_content ?? null,
          tool_calls: toolCalls,
        })

        for (const toolCall of toolCalls) {
          const name = toolCall.function.name
          const parsedArgs = parseToolCallArgs(toolCall.function.arguments)
          if (!parsedArgs.ok) {
            // 子 agent 的 arguments 是坏 JSON（最常见成因是 finish_reason='length' 把它截断）：
            //   · 【不执行】该工具 —— 旧的 safeParseArgs 会把半截 JSON 降级成 {} 再照常执行，
            //     等于拿默认参数干活（delegate_agent 少个 children、read_file 少个 path 之类），
            //     模型只会看到一个误导性的「缺参数」报错，去改参数值而非重发 JSON。
            //   · 【必须回填】一条错误 tool 结果 —— 每个 tool_call 都得有对应 tool 消息，
            //     漏一条下一轮消息序列就非法，整条子 agent 循环会被接口拒。
            //   判据与主循环（modelRun）共用 parseToolCallArgs：空 arguments 仍是无参工具的
            //   合法形态（ok:true + {}），只有非法 JSON 与「合法 JSON 但非对象」才落到这里。
            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: JSON.stringify({
                error: parsedArgs.error,
                hint: '请重新发起该工具调用，并确保 arguments 是完整合法的 JSON 对象',
                argumentsPreview: argsPreviewForModel(parsedArgs.raw),
              }),
            })
            continue
          }
          const callArgs = parsedArgs.args

          if (name === 'request_tool_schema') {
            const toolName = typeof callArgs.toolName === 'string' ? callArgs.toolName : ''
            await recordEvent(context, archiveBasePath, 'child_tool_schema_requested', node.path, {
              toolName,
            })
            if (!allowedToolNames.includes(toolName)) {
              messages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                content: JSON.stringify({ error: `tool not allowed for child agent: ${toolName}` }),
              })
              continue
            }
            visible = appendVisibleTool(visible, toolName)
            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: JSON.stringify(toolRegistry.loadSchema(toolName) ?? { error: 'unknown' }),
            })
            continue
          }

          if (name === DELEGATE_TOOL_NAME) {
            if (agentPathDepth(node.path) >= budget.maxDepth) {
              messages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                content: JSON.stringify({ error: `max subagent depth reached at ${node.path}` }),
              })
              continue
            }

            const normalized = normalizeDelegateAgentInput(callArgs)
            if (!normalized.ok) {
              messages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                content: JSON.stringify({ error: normalized.error }),
              })
              continue
            }

            await recordEvent(context, archiveBasePath, 'nested_delegate_requested', node.path, {
              children: normalized.input.children.length,
              maxDepth: budget.maxDepth,
              maxChildren: budget.maxChildren,
            })
            let nested: DelegateAgentBatchResult | { error: string }
            try {
              const parentConfirmedTools = confirmedToolsByPath.get(node.path) ?? []
              nested = await delegateAgents(callArgs as unknown as DelegateAgentInput, {
                ...context,
                parentPath: node.path,
                delegationCallId: toolCall.id,
                dangerousToolCapability: parentConfirmedTools.length > 0
                  ? {
                      sessionId: opts.sessionId,
                      runId: opts.runId,
                      delegationCallId: toolCall.id,
                      parentPath: node.path,
                      toolNames: parentConfirmedTools,
                    }
                  : undefined,
                parentTranscript: formatSubagentTranscript(messages),
                inheritedSkillFiles: skillFiles,
                inheritedSkillIds: skillIds,
                inheritedSkillContents: [...inheritedSkills, localSkill],
              })
            } catch (error) {
              if (isAbortError(error, opts.signal)) throw error
              nested = { error: toErrorMessage(error) }
            }
            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: JSON.stringify(nested),
            })
            continue
          }

          if ((isSubagentWorkspaceReadTool(name) || isDangerousTool(name)) && allowedToolNames.includes(name)) {
            if (!context.runChildTool) {
              messages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                content: JSON.stringify({ error: `child tool unavailable: ${name}` }),
              })
              continue
            }
            const startedAt = Date.now()
            let toolResult:
              | { ok: true; data?: unknown; warnings?: string[] }
              | { ok: false; error: string }
            try {
              toolResult = await context.runChildTool(name, callArgs)
            } catch (error) {
              if (isAbortError(error, opts.signal)) throw error
              toolResult = { ok: false, error: toErrorMessage(error) }
            }
            await bestEffortRecordEvent(context, archiveBasePath, 'child_tool_finished', node.path, {
              toolName: name,
              ok: toolResult.ok,
              durationMs: Date.now() - startedAt,
            })
            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: JSON.stringify(
                toolResult.ok
                  ? toolResult.warnings?.length
                    ? { data: toolResult.data ?? { ok: true }, warnings: toolResult.warnings }
                    : (toolResult.data ?? { ok: true })
                  : { error: toolResult.error },
              ),
            })
            continue
          }

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify({ error: `tool not allowed for child agent: ${name}` }),
          })
        }
      }

      throw new Error(`child agent exceeded maxTurns ${maxTurns}`)
    } catch (error) {
      const message = toErrorMessage(error)
      const status = isAbortError(error, opts.signal) ? 'cancelled' : 'failed'
      subagentScheduler.markNode(opts.runId, node.path, status, {
        error: message,
        localSkillFiles: [localSkill.path],
        localSkillIds: [localSkill.skillId],
        inheritedSkillFiles: [...node.inheritedSkillFiles],
        inheritedSkillIds: [...node.inheritedSkillIds],
      })
      await bestEffortRecordEvent(context, archiveBasePath, 'child_finished', node.path, {
        status,
        objective: spec.objective,
        summary: message,
        error: message,
        skillFiles,
        skillIds,
      })
      return {
        path: node.path,
        status,
        objective: spec.objective,
        summary: message,
        skillFiles,
        skillIds,
        error: message,
      }
    }
  }

  async function delegateAgents(
    rawInput: DelegateAgentInput,
    context: DelegateAgentCallContext,
  ): Promise<DelegateAgentBatchResult> {
    const normalized = normalizeDelegateAgentInput(rawInput)
    if (!normalized.ok) throw new Error(normalized.error)
    const input = normalized.input
    const parentPath = context.parentPath || ROOT_AGENT_PATH
    const archiveBasePath = subagentCacheBasePath(opts.sessionId, opts.runId)

    if (!rootBudget) {
      rootBudget = {
        maxDepth: input.maxDepth ?? 2,
        maxChildren: input.maxChildren ?? 6,
        maxConcurrent: input.maxConcurrent ?? 4,
        maxTotalNodes: input.maxTotalNodes ?? 64,
        maxModelCalls: input.maxModelCalls ?? 128,
      }
      modelCallSemaphore = new ModelCallSemaphore(rootBudget.maxConcurrent)
      budgetByPath.set(ROOT_AGENT_PATH, rootBudget)
      rootToolProfile = input.toolProfile ?? DEFAULT_SUBAGENT_TOOL_PROFILE
      toolProfileByPath.set(ROOT_AGENT_PATH, rootToolProfile)
    }
    const inheritedBudget = budgetByPath.get(parentPath) ?? rootBudget
    const budget: TreeRuntimeBudget = {
      maxDepth: hasOwn(rawInput, 'maxDepth')
        ? Math.min(inheritedBudget.maxDepth, input.maxDepth ?? inheritedBudget.maxDepth)
        : inheritedBudget.maxDepth,
      maxChildren: hasOwn(rawInput, 'maxChildren')
        ? Math.min(inheritedBudget.maxChildren, input.maxChildren ?? inheritedBudget.maxChildren)
        : inheritedBudget.maxChildren,
      maxConcurrent: hasOwn(rawInput, 'maxConcurrent')
        ? Math.min(inheritedBudget.maxConcurrent, input.maxConcurrent ?? inheritedBudget.maxConcurrent)
        : inheritedBudget.maxConcurrent,
      maxTotalNodes: hasOwn(rawInput, 'maxTotalNodes')
        ? Math.min(inheritedBudget.maxTotalNodes, input.maxTotalNodes ?? inheritedBudget.maxTotalNodes)
        : inheritedBudget.maxTotalNodes,
      maxModelCalls: hasOwn(rawInput, 'maxModelCalls')
        ? Math.min(inheritedBudget.maxModelCalls, input.maxModelCalls ?? inheritedBudget.maxModelCalls)
        : inheritedBudget.maxModelCalls,
    }
    const inheritedToolProfile = toolProfileByPath.get(parentPath)
      ?? rootToolProfile
      ?? DEFAULT_SUBAGENT_TOOL_PROFILE
    const requestedToolProfile = hasOwn(rawInput, 'toolProfile')
      ? input.toolProfile ?? DEFAULT_SUBAGENT_TOOL_PROFILE
      : inheritedToolProfile
    if (!canNarrowSubagentToolProfile(inheritedToolProfile, requestedToolProfile)) {
      throw new Error(
        `invalid delegate_agent: toolProfile ${requestedToolProfile} cannot widen inherited ${inheritedToolProfile}`,
      )
    }
    for (const child of input.children) {
      const childToolProfile = child.toolProfile ?? requestedToolProfile
      if (!canNarrowSubagentToolProfile(requestedToolProfile, childToolProfile)) {
        throw new Error(
          `invalid delegate_agent: child toolProfile ${childToolProfile} cannot widen inherited ${requestedToolProfile}`,
        )
      }
    }
    const pathConfirmedTools = confirmedToolsByPath.get(parentPath) ?? []
    const capability = context.dangerousToolCapability
    const capabilityIsScoped = capability
      && capability.sessionId === opts.sessionId
      && capability.runId === opts.runId
      && capability.parentPath === parentPath
      && typeof context.delegationCallId === 'string'
      && capability.delegationCallId === context.delegationCallId
      && capability.toolNames.every(isDangerousTool)
      && (parentPath === ROOT_AGENT_PATH || isSubset(capability.toolNames, pathConfirmedTools))
    const inheritedConfirmedTools = capabilityIsScoped ? Array.from(new Set(capability.toolNames)) : []
    if (parentPath === ROOT_AGENT_PATH) {
      // A runtime can serve several root delegate calls. Replace, never reuse, the previous call's grant.
      confirmedToolsByPath.set(ROOT_AGENT_PATH, inheritedConfirmedTools)
    }
    // Dangerous permissions are never inherited by omission. Every delegate call must explicitly
    // request a subset of the capability held by its parent path.
    const requestedConfirmedTools = hasOwn(rawInput, 'confirmedTools') ? (input.confirmedTools ?? []) : []
    if (!isSubset(requestedConfirmedTools, inheritedConfirmedTools)) {
      throw new Error('invalid delegate_agent: confirmedTools cannot exceed the verified parent capability')
    }
    for (const child of input.children) {
      const childConfirmedTools = child.confirmedTools ?? requestedConfirmedTools
      if (!isSubset(childConfirmedTools, requestedConfirmedTools)) {
        throw new Error('invalid delegate_agent: child confirmedTools cannot widen the batch capability')
      }
    }

    if (agentPathDepth(parentPath) >= budget.maxDepth) {
      throw new Error(`max subagent depth reached at ${parentPath}`)
    }
    if (input.children.length > budget.maxChildren) {
      throw new Error(
        `invalid delegate_agent: children length ${input.children.length} exceeds inherited maxChildren ${budget.maxChildren}`,
      )
    }

    await ensureArchiveInitialized(context, archiveBasePath)
    subagentScheduler.markNode(opts.runId, parentPath, 'running')
    await recordEvent(context, archiveBasePath, 'delegate_requested', parentPath, {
      children: input.children.map((child) => ({
        objective: child.objective,
        mode: child.mode,
        expectedOutput: child.expectedOutput,
        toolProfile: child.toolProfile ?? requestedToolProfile,
        confirmedTools: child.confirmedTools ?? requestedConfirmedTools,
      })),
      strategy: input.strategy ?? 'parallel_wait_all',
      maxDepth: budget.maxDepth,
      maxChildren: budget.maxChildren,
      maxConcurrent: budget.maxConcurrent,
      maxTotalNodes: budget.maxTotalNodes,
      maxModelCalls: budget.maxModelCalls,
      totalNodesUsed,
      modelCallsUsed,
      toolProfile: requestedToolProfile,
      confirmedTools: requestedConfirmedTools,
    })
    context.progress(`启动 ${input.children.length} 个子 agent: ${parentPath}`)
    const parentTranscript = context.parentTranscript ?? ''
    const inheritedSkillFiles = context.inheritedSkillFiles ?? []
    const inheritedSkillIds =
      context.inheritedSkillIds ?? context.inheritedSkillContents?.map((skill) => skill.skillId) ?? []
    const inheritedSkillContents = context.inheritedSkillContents ?? []
    try {
      reserveNodes(input.children.length, budget.maxTotalNodes)
    } catch (error) {
      const message = toErrorMessage(error)
      await bestEffortRecordEvent(context, archiveBasePath, 'delegate_finished', parentPath, {
        status: 'failed',
        children: [],
        error: message,
        budgetUsage: budgetUsage(),
      })
      try {
        await writeRunArchiveRecord(
          context,
          archiveBasePath,
          'delegated',
          parentPath === ROOT_AGENT_PATH,
        )
      } catch {
        // Preserve the budget error as the primary failure.
      }
      throw error
    }
    let reserved: SubagentNodeRecord[]
    try {
      reserved = subagentScheduler.reserveChildren({
        treeId: opts.runId,
        sessionId: opts.sessionId,
        parentPath,
        inheritedSkillFiles,
        inheritedSkillIds,
        children: input.children,
      })
    } catch (error) {
      totalNodesUsed -= input.children.length
      throw error
    }
    reserved.forEach((node, index) => {
      const spec = input.children[index]
      budgetByPath.set(node.path, {
        maxDepth: Math.min(budget.maxDepth, spec.maxDepth ?? budget.maxDepth),
        maxChildren: Math.min(budget.maxChildren, spec.maxChildren ?? budget.maxChildren),
        maxConcurrent: budget.maxConcurrent,
        maxTotalNodes: budget.maxTotalNodes,
        maxModelCalls: budget.maxModelCalls,
      })
      toolProfileByPath.set(node.path, spec.toolProfile ?? requestedToolProfile)
      confirmedToolsByPath.set(node.path, spec.confirmedTools ?? requestedConfirmedTools)
    })
    const parentSnapshot = subagentScheduler.snapshot(opts.runId).find((node) => node.path === parentPath)
    const parentDispatchIndex = parentSnapshot ? Math.max(1, parentSnapshot.dispatchCounter) : 1
    await recordEvent(context, archiveBasePath, 'children_reserved', parentPath, {
      paths: reserved.map((node) => node.path),
      dispatchCounter: parentDispatchIndex,
      totalNodesUsed,
      maxTotalNodes: rootBudget.maxTotalNodes,
    })

    for (const node of reserved) {
      subagentScheduler.markNode(opts.runId, node.path, 'distilling')
    }

    let distilled
    try {
      distilled = await distillDelegateSkills({
        conversationId: opts.sessionId,
        runId: opts.runId,
        cacheBasePath: archiveBasePath,
        parentPath,
        parentDispatchIndex,
        strategy: input.strategy ?? 'parallel_wait_all',
        parentTranscript,
        inheritedSkillFiles,
        inheritedSkillIds,
        children: reserved.map((node, index) => ({ node, spec: input.children[index] })),
        chat: (request) =>
          distillChat(request, budget.maxModelCalls, {
            context,
            archiveBasePath,
            agentPath: parentPath,
            turn: 0, // distill 不是「轮」，靠 phase 区分（见 CallModelObservation）。
            phase: 'distill',
          }),
      })
    } catch (error) {
      const message = toErrorMessage(error)
      const status = isAbortError(error, opts.signal) ? 'cancelled' : 'failed'
      const children: ChildAgentResult[] = reserved.map((node, index) => {
        subagentScheduler.markNode(opts.runId, node.path, status, { error: message })
        return {
          path: node.path,
          status,
          objective: input.children[index].objective,
          summary: message,
          skillFiles: [...node.inheritedSkillFiles],
          skillIds: [...node.inheritedSkillIds],
          error: message,
        }
      })
      if (parentPath === ROOT_AGENT_PATH) subagentScheduler.markNode(opts.runId, parentPath, status, { error: message })
      await Promise.all(
        children.map((child) =>
          bestEffortRecordEvent(context, archiveBasePath, 'child_finished', child.path, {
            status: child.status,
            objective: child.objective,
            summary: child.summary,
            skillFiles: child.skillFiles,
            skillIds: child.skillIds,
            error: child.error,
          }),
        ),
      )
      try {
        await persistTreeSnapshot(context, archiveBasePath, subagentScheduler.snapshot(opts.runId))
        await writeRunArchiveRecord(
          context,
          archiveBasePath,
          'delegated',
          parentPath === ROOT_AGENT_PATH,
        )
      } catch {
        // Keep the distillation/abort error as the primary failure.
      }
      await bestEffortRecordEvent(context, archiveBasePath, 'delegate_finished', parentPath, {
        status,
        children: children.map((child) => ({ path: child.path, status: child.status })),
        error: message,
        budgetUsage: budgetUsage(),
      })
      throw error
    }

    const allDistilledFiles = [distilled.coreSkill, ...distilled.childSkills]
    await Promise.all(allDistilledFiles.map((skill) => persistSkill(context, archiveBasePath, skill)))
    const parentBefore = subagentScheduler.snapshot(opts.runId).find((node) => node.path === parentPath)
    subagentScheduler.markNode(opts.runId, parentPath, 'running', {
      localSkillFiles: Array.from(new Set([...(parentBefore?.localSkillFiles ?? []), distilled.coreSkill.path])),
      localSkillIds: Array.from(new Set([...(parentBefore?.localSkillIds ?? []), distilled.coreSkill.skillId])),
      inheritedSkillFiles,
      inheritedSkillIds,
    })

    const tasks = reserved.map((node, index) => async () =>
      runChildAgent({
        node: {
          ...node,
          inheritedSkillFiles: [...inheritedSkillFiles, distilled.coreSkill.path],
          inheritedSkillIds: [...inheritedSkillIds, distilled.coreSkill.skillId],
        },
        spec: input.children[index],
        context,
        archiveBasePath,
        inheritedSkills: [...inheritedSkillContents, distilled.coreSkill],
        localSkill: distilled.childSkills[index],
        budget: budgetByPath.get(node.path) ?? budget,
        toolProfile: toolProfileByPath.get(node.path) ?? requestedToolProfile,
        confirmedTools: confirmedToolsByPath.get(node.path) ?? [],
      }),
    )

    const children = await runWithConcurrency(tasks, budget.maxConcurrent)
    const summary = childSummary(children)
    const status = batchStatus(input.strategy, summary)
    // Tree node status is kept backward-compatible; partial is represented by done parent + failed
    // child nodes, while the batch result/event carries the precise `partial` outcome.
    const parentNodeStatus = status === 'partial' ? 'done' : status
    if (parentPath === ROOT_AGENT_PATH) {
      subagentScheduler.markNode(opts.runId, parentPath, parentNodeStatus)
    }
    const snapshot = subagentScheduler.snapshot(opts.runId)
    await persistTreeSnapshot(context, archiveBasePath, snapshot)
    await writeRunArchiveRecord(
      context,
      archiveBasePath,
      'delegated',
      parentPath === ROOT_AGENT_PATH,
    )
    await recordEvent(context, archiveBasePath, 'delegate_finished', parentPath, {
      status,
      summary,
      children: children.map((child) => ({ path: child.path, status: child.status })),
      skillIds: allDistilledFiles.map((skill) => skill.skillId),
      budgetUsage: budgetUsage(),
    })

    return {
      treeId: opts.runId,
      conversationId: opts.sessionId,
      runId: opts.runId,
      parentPath,
      strategy: input.strategy ?? 'parallel_wait_all',
      status,
      summary,
      cacheBasePath: archiveBasePath,
      archiveBasePath,
      eventLog: subagentEventsPath(archiveBasePath),
      skillFiles: allDistilledFiles.map((skill) => skill.path),
      skillIds: allDistilledFiles.map((skill) => skill.skillId),
      budgetUsage: budgetUsage(),
      children,
    }
  }

  return {
    delegateAgents,
    async dispose() {
      try {
        await archiveWriter.close()
      } finally {
        budgetByPath.clear()
        toolProfileByPath.clear()
        confirmedToolsByPath.clear()
        subagentScheduler.clear(opts.runId)
      }
    },
  }
}
