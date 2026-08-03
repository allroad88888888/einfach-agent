import {
  callDeepSeek,
  DEEPSEEK_FLASH_MODEL,
  maxTurnToolsForVendor,
  normalizeCacheUsage,
  type DeepSeekChatRequest,
} from '@web-agent/ai'
import { callGlm, type GlmChatRequest } from '@web-agent/ai'
import type {
  ModelChatResponse,
  ModelFunctionTool,
  ModelItem,
  ThinkingConfig,
} from '@web-agent/ai'
import type { ModelSettings } from '../state/core.type'
import type { CoreInstance } from '../runtime/core/coreInstance'
import { normalizePrimaryAgentSettings } from '../state/persistence/modelMigration'
import { toolRegistry } from '../tools/registry'
import type { ToolRegistry } from '../tools/toolRegistry'
import type { LoadedTool } from '../tools/types'
import {
  buildTurnTools,
  narrowToolCalls,
  parseToolCallArgs,
  searchToolManifestPage,
  touchRecentToolName,
} from '../runtime/modelTurn'
import { selectToolGate } from '../runtime/toolGates'
import { compactContext, estimateTokensFromText } from '../runtime/contextCompaction'
import {
  createContextCacheTracker,
  type ContextCacheLane,
} from '../runtime/contextCache'
import {
  FINISH_REASON_ERRORS,
  isAbnormalFinishReason,
} from '../runtime/core/plugins/finishReasonPlugin'
import { createConcurrencyLimiter, type ConcurrencyLimiter } from './concurrency'
import { normalizeDelegateAgentInput } from './input'
import {
  callSelectedSubagentModel,
  createSubagentModelSelection,
  routeChildModel,
  supportsDeepSeekTierRouting,
} from './modelSelection'
import { buildChildSystemPrompt, buildChildUserPrompt } from './prompt'
import { SubagentArchiveIO } from './archiveIO'
import { ROOT_AGENT_PATH, agentPathDepth } from './path'
import { subagentScheduler, type SubagentScheduler } from './scheduler'
import {
  canNarrowSubagentToolProfile,
  DEFAULT_SUBAGENT_TOOL_PROFILE,
  isSubagentVerificationTool,
  isSubagentWorkspaceReadTool,
  subagentAllowedTools,
} from './toolProfile'
import {
  subagentCacheBasePath,
  subagentEventsPath,
  subagentResultPath,
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
  SubagentNodeRecord,
  SubagentSkillFile,
  SubagentToolProfile,
} from './types'
import { isDelegatableDangerousTool } from '../runtime/dangerousTools'
import { toolSchemaLoadedResult } from '../tools/schemaResult'

const DELEGATE_TOOL_NAME = 'delegate_agent'
const DEFAULT_CHILD_MAX_TURNS = 4
// 回填给子 agent 的坏参数原文截断长度，与主循环 modelRun 的 ARGS_PREVIEW_LIMIT 对齐。
const ARGS_PREVIEW_LIMIT = 200
// 回填给父 agent 的「截断片段」预览长度：只用于定位断在哪里，不是可用产出。
const TRUNCATED_TEXT_PREVIEW_LIMIT = 200

// ---------------------------------------------------------------------------
// 子 agent 循环的上下文压缩预算（与主循环 modelRun 【故意不共用】常量）
// ---------------------------------------------------------------------------
// 为什么子 agent 需要压缩：轮数确实有硬顶（input.ts 的 HARD_MAX_TURNS=16 会 clamp 掉模型自报的
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

type ChildChangeSet = { id: string; reversible: boolean }

function collectChangeSets(value: unknown, target: ChildChangeSet[]): void {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((item) => collectChangeSets(item, target))
    return
  }
  const record = value as Record<string, unknown>
  const candidate = record.changeSet
  if (
    candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    && typeof (candidate as Record<string, unknown>).id === 'string'
    && typeof (candidate as Record<string, unknown>).reversible === 'boolean'
  ) {
    const summary = candidate as ChildChangeSet
    if (!target.some((item) => item.id === summary.id)) {
      target.push({ id: summary.id, reversible: summary.reversible })
    }
  }
  if (Array.isArray(record.changeSets)) {
    for (const item of record.changeSets) {
      if (
        item && typeof item === 'object' && !Array.isArray(item)
        && typeof (item as Record<string, unknown>).id === 'string'
        && typeof (item as Record<string, unknown>).reversible === 'boolean'
      ) {
        const summary = item as ChildChangeSet
        if (!target.some((existing) => existing.id === summary.id)) {
          target.push({ id: summary.id, reversible: summary.reversible })
        }
      }
    }
  }
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
  // distill 不是「轮」——它是一次性的蒸馏调用，turn 恒为 0。
  turn: number
  // 哪个阶段发起的调用。各 lane 使用独立缓存 profile，避免工具集和稳定前缀不同的请求
  // 被观测层错误归为同一个缓存序列。
  phase: Exclude<ContextCacheLane, 'main'>
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

interface DelegationCallState {
  rootBudget: TreeRuntimeBudget
  modelCallLimiter: ConcurrencyLimiter
  totalNodesUsed: number
  modelCallsUsed: number
  budgetByPath: Map<string, TreeRuntimeBudget>
  toolProfileByPath: Map<string, SubagentToolProfile>
  confirmedToolsByPath: Map<string, readonly string[]>
}

interface CreateDelegateAgentRuntimeOptions {
  sessionId: string
  runId: string
  settings: ModelSettings
  /** Core that owns the archive write lock. Defaults to the legacy default core. */
  core?: CoreInstance
  /** Registry owned by the current CoreInstance. Defaults to the legacy singleton for direct callers. */
  registry?: ToolRegistry
  /** Scheduler owned by the current CoreInstance. Defaults to the legacy default-core proxy. */
  scheduler?: SubagentScheduler
  customInstructions?: string
  /**
   * 父 agent 那份「运行环境」段的正文（buildEnvironmentItem 的产物）。
   * 孩子和父亲跑在同一台机器、同一个 workspace 上，缺这段同样会凭空编绝对路径；
   * 由 modelRun 把已算好的正文传下来，避免 subagents 反向去摸 store。
   */
  environment?: string
  /** Stable, opaque installation identifier sent only to DeepSeek request bodies. */
  deepseekUserId?: string
  apiKey: string
  signal: AbortSignal
  fetchImpl?: typeof fetch
  onNodeChange?(node: SubagentNodeRecord): void
  onTraceItem?(input: {
    agentPath: string
    timestamp: string
    turn: number
    item: ModelItem
  }): void
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

function cacheHitRate(hitTokens?: number, missTokens?: number): number | undefined {
  if (typeof hitTokens !== 'number' || typeof missTokens !== 'number') return undefined
  const total = hitTokens + missTokens
  return total > 0 ? hitTokens / total : undefined
}

function firstAssistantText(response: ModelChatResponse): string {
  const content = response.choices?.[0]?.message?.content
  return typeof content === 'string' ? content.trim() : ''
}

function appendVisibleTool(
  current: LoadedTool[],
  name: string,
  registry: ToolRegistry,
  maxLoadedTools: number,
): LoadedTool[] {
  const tool = registry.loadSchema(name)
  if (!tool) return current.filter((loaded) => loaded.name !== name)
  const existing = current.find((loaded) => loaded.name === name)
  const snapshot = existing?.registrationVersion === tool.registrationVersion ? existing : tool
  const visible = [
    ...current.filter((loaded) => loaded.name !== name),
    snapshot,
  ]
  return maxLoadedTools > 0 ? visible.slice(-maxLoadedTools) : []
}

function refreshChildVisibleTools(
  current: LoadedTool[],
  registry: ToolRegistry,
  maxLoadedTools: number,
): LoadedTool[] {
  const visible = current.reduce<LoadedTool[]>((refreshed, snapshot) => {
    const latest = registry.loadSchema(snapshot.name)
    if (!latest) return refreshed
    return [
      ...refreshed,
      latest.registrationVersion === snapshot.registrationVersion ? snapshot : latest,
    ]
  }, [])
  return maxLoadedTools > 0 ? visible.slice(-maxLoadedTools) : []
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

export function createDelegateAgentRuntime(
  rawOpts: CreateDelegateAgentRuntimeOptions,
): DelegateAgentRuntime {
  const registry = rawOpts.registry ?? toolRegistry
  const scheduler = rawOpts.scheduler ?? subagentScheduler
  const ownerSignal = rawOpts.signal
  const runtimeController = new AbortController()
  const abortFromOwner = () => runtimeController.abort(ownerSignal.reason)
  ownerSignal.addEventListener('abort', abortFromOwner, { once: true })
  if (ownerSignal.aborted) abortFromOwner()
  // 请求路径兜底（同 modelRun）：迁移下线模型名，并确保主 Agent/蒸馏调用使用 Pro。
  // Flash 只在 runChildAgent 根据主 Agent 的显式 modelTier 选择后临时覆盖。
  const migratedSettings = normalizePrimaryAgentSettings(rawOpts.settings)
  const opts: CreateDelegateAgentRuntimeOptions = {
    ...rawOpts,
    settings: migratedSettings,
    signal: runtimeController.signal,
  }
  const archive = new SubagentArchiveIO({
    core: opts.core,
    sessionId: opts.sessionId,
    runId: opts.runId,
    model: opts.settings.model,
    vendor: opts.settings.vendor,
    onTraceItem: opts.onTraceItem,
  })
  const contextCacheTracker = createContextCacheTracker()
  let nextChangeSetOrder = 0
  const changeSetOrder = new Map<string, number>()
  const delegationStateByChildPath = new Map<string, DelegationCallState>()
  let lowCostExtractionState: DelegationCallState | undefined
  let owners = 1
  let disposed = false
  let cleanup: Promise<void> | undefined
  const unsubscribeScheduler = opts.onNodeChange
    ? scheduler.subscribe((node) => {
        if (node.treeId === opts.runId && node.sessionId === opts.sessionId) {
          opts.onNodeChange?.(node)
        }
      })
    : undefined
  function createDelegationCallState(input?: Pick<
    DelegateAgentInput,
    'maxDepth' | 'maxChildren' | 'maxConcurrent' | 'maxTotalNodes' | 'maxModelCalls'
  >): DelegationCallState {
    const rootBudget: TreeRuntimeBudget = {
      maxDepth: input?.maxDepth ?? 2,
      maxChildren: input?.maxChildren ?? 6,
      maxConcurrent: input?.maxConcurrent ?? 4,
      maxTotalNodes: input?.maxTotalNodes ?? 64,
      maxModelCalls: input?.maxModelCalls ?? 128,
    }
    return {
      rootBudget,
      modelCallLimiter: createConcurrencyLimiter(rootBudget.maxConcurrent),
      totalNodesUsed: 1,
      modelCallsUsed: 0,
      budgetByPath: new Map([[ROOT_AGENT_PATH, rootBudget]]),
      toolProfileByPath: new Map(),
      confirmedToolsByPath: new Map(),
    }
  }

  function reserveNodes(state: DelegationCallState, count: number, limit: number): void {
    const effectiveLimit = Math.min(state.rootBudget.maxTotalNodes, limit)
    const remaining = Math.max(0, effectiveLimit - state.totalNodesUsed)
    if (count > remaining) {
      throw new Error(
        `subagent tree node budget exhausted: requested ${count}, remaining ${remaining}, used ${state.totalNodesUsed} of ${effectiveLimit}`,
      )
    }
    state.totalNodesUsed += count
  }

  function reserveModelCall(state: DelegationCallState, limit: number): void {
    const effectiveLimit = Math.min(state.rootBudget.maxModelCalls, limit)
    if (state.modelCallsUsed >= effectiveLimit) {
      throw new Error(
        `subagent tree model-call budget exhausted: used ${state.modelCallsUsed} of ${effectiveLimit}`,
      )
    }
    state.modelCallsUsed += 1
  }

  function budgetUsage(state: DelegationCallState): DelegateAgentBatchResult['budgetUsage'] {
    return {
      totalNodes: {
        used: state.totalNodesUsed,
        limit: state.rootBudget.maxTotalNodes,
      },
      modelCalls: {
        used: state.modelCallsUsed,
        limit: state.rootBudget.maxModelCalls,
      },
    }
  }

  function observeChangeSets(value: unknown, target: ChildChangeSet[]): void {
    collectChangeSets(value, target)
    for (const changeSet of target) {
      if (!changeSetOrder.has(changeSet.id)) {
        changeSetOrder.set(changeSet.id, nextChangeSetOrder++)
      }
    }
  }

  async function callModel(state: DelegationCallState, args: {
    messages: ModelItem[]
    tools?: ModelFunctionTool[]
    toolChoice?: 'auto' | 'none'
    settings?: ModelSettings
    // 可观测性上下文。不传 = 本次调用不记压缩事件（见下方 distillChat 的说明）。
    observe?: CallModelObservation
  }, maxModelCalls?: number): Promise<ModelChatResponse> {
    const modelCallLimit = maxModelCalls ?? state.rootBudget.maxModelCalls
    const settings = args.settings ?? opts.settings

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
      (settings.max_tokens ?? SUBAGENT_RESERVED_OUTPUT_TOKENS) +
      Math.ceil(SUBAGENT_CONTEXT_BUDGET_TOKENS * SUBAGENT_CONTEXT_SAFETY_MARGIN_RATIO)
    const compaction = compactContext(args.messages, {
      maxTokens: SUBAGENT_CONTEXT_BUDGET_TOKENS,
      reservedTokens,
      keepRecentTurns: SUBAGENT_KEEP_RECENT_TURNS,
      replayUnsafeToolNames: registry.replayUnsafeToolNames(),
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
      const { context, archiveBasePath, agentPath, turn, phase } = args.observe
      if (compaction.compacted) {
        // 字段口径对齐主循环 modelRun 的 'llm.context_compacted'（便于两侧交叉对照）。
        // ★ key 里避开 "token" 子串、改用 Tk 后缀 ★：observability/redact.ts 的 SENSITIVE_KEY
        //   是子串匹配且含 |token|，命中的 key 会被整个抹成 '[REDACTED]'。归档目前不过那条
        //   脱敏管道，但指标名一旦定死就会被复制到别处，先按安全形态定名。
        await archive.bestEffortRecordEvent(context, archiveBasePath, 'child_context_compacted', agentPath, {
          turn,
          phase,
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
        await archive.bestEffortRecordEvent(context, archiveBasePath, 'child_context_over_budget', agentPath, {
          turn,
          phase,
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
      model: settings.model,
      messages: compaction.items,
      temperature: settings.temperature,
      max_tokens: settings.max_tokens,
      thinking: thinkingConfig(settings),
      tools: args.tools,
      tool_choice: args.toolChoice ?? 'auto',
      stream: false,
    }
    const callOptions = { apiKey: opts.apiKey, signal: opts.signal, fetchImpl: opts.fetchImpl }
    const cacheLane = args.observe?.phase ?? 'subagent'
    const systemContent =
      compaction.items.find((item) => item.role === 'system')?.content ?? ''
    const requestMode = cacheLane.startsWith('distill:')
      ? cacheLane
      : args.toolChoice === 'none'
        ? 'final_synthesis'
        : 'tool_loop'
    const cacheProfile = contextCacheTracker.observe({
      lane: cacheLane,
      scope: `${opts.sessionId}:${opts.runId}:${args.observe?.agentPath ?? 'unobserved'}:${cacheLane}`,
      vendor: settings.vendor,
      model: settings.model,
      messages: compaction.items,
      systemContent,
      tools: args.tools ?? [],
      toolChoice: args.toolChoice ?? 'auto',
      thinking: thinkingConfig(settings)?.type,
      reasoningEffort: settings.reasoning_effort,
      compacted: compaction.compacted,
      requestMode,
    })

    const invoke = () => {
      reserveModelCall(state, modelCallLimit)
      if (settings.vendor === 'glm') {
        const body: GlmChatRequest = {
          ...requestBase,
          reasoning_effort: settings.reasoning_effort,
        }
        return callGlm(body, callOptions)
      }

      const body: DeepSeekChatRequest = {
        ...requestBase,
        reasoning_effort: settings.reasoning_effort,
        user_id: opts.deepseekUserId,
      }
      return callDeepSeek(body, callOptions)
    }
    let response: ModelChatResponse
    try {
      response = await (
        state.modelCallLimiter.run(invoke, opts.signal)
      )
    } catch (error) {
      if (args.observe) {
        await archive.bestEffortRecordEvent(
          args.observe.context,
          args.observe.archiveBasePath,
          'child_model_usage',
          args.observe.agentPath,
          {
            turn: args.observe.turn,
            phase: args.observe.phase,
            vendor: settings.vendor,
            model: settings.model,
            cacheMetricsStatus: isAbortError(error, opts.signal) ? 'cancelled' : 'request_failed',
            cacheLane: cacheProfile.lane,
            cacheProfile: cacheProfile.profileId,
            cacheEpoch: cacheProfile.epoch,
            cacheEpochReason: cacheProfile.epochReason,
            cacheProtocolVersion: cacheProfile.protocolVersion,
            laneScopeFingerprint: cacheProfile.laneScopeFingerprint,
            systemFingerprint: cacheProfile.systemFingerprint,
            requestProjectionFingerprint: cacheProfile.requestProjectionFingerprint,
            toolSetFingerprint: cacheProfile.toolSetFingerprint,
            compactionBoundary: cacheProfile.compactionBoundary,
            contextCompacted: compaction.compacted,
            withinBudget: compaction.withinBudget,
            error: toErrorMessage(error),
          },
        )
      }
      throw error
    }

    // Provider 的隐式前缀缓存不需要、也不接受本地伪造 cache_id。这里记录的 profile/epoch
    // 只解释稳定前缀边界；真实命中率严格来自响应 usage，缺失时明确标记 unavailable。
    if (args.observe) {
      const cacheUsage = normalizeCacheUsage(response.usage)
      const hitRate = cacheHitRate(cacheUsage?.hitTokens, cacheUsage?.missTokens)
      const promptTk = response.usage?.prompt_tokens ?? response.usage?.input_tokens
      const completionTk = response.usage?.completion_tokens ?? response.usage?.output_tokens
      await archive.bestEffortRecordEvent(
        args.observe.context,
        args.observe.archiveBasePath,
        'child_model_usage',
        args.observe.agentPath,
        {
          turn: args.observe.turn,
          phase: args.observe.phase,
          vendor: settings.vendor,
          model: settings.model,
          ...(typeof promptTk === 'number' ? { promptTk } : {}),
          ...(typeof completionTk === 'number' ? { completionTk } : {}),
          ...(typeof response.usage?.total_tokens === 'number'
            ? { totalTk: response.usage.total_tokens }
            : {}),
          cacheMetricsStatus: cacheUsage ? 'available' : 'unavailable',
          ...(typeof cacheUsage?.hitTokens === 'number'
            ? { cacheHitTk: cacheUsage.hitTokens }
            : {}),
          ...(typeof cacheUsage?.missTokens === 'number'
            ? { cacheMissTk: cacheUsage.missTokens }
            : {}),
          ...(cacheUsage?.missSource
            ? { cacheMissSource: cacheUsage.missSource }
            : {}),
          ...(typeof cacheUsage?.writeTokens === 'number'
            ? { cacheWriteTk: cacheUsage.writeTokens }
            : {}),
          ...(typeof hitRate === 'number' ? { cacheHitRate: hitRate } : {}),
          cacheLane: cacheProfile.lane,
          cacheProfile: cacheProfile.profileId,
          cacheEpoch: cacheProfile.epoch,
          cacheEpochReason: cacheProfile.epochReason,
          cacheProtocolVersion: cacheProfile.protocolVersion,
          laneScopeFingerprint: cacheProfile.laneScopeFingerprint,
          systemFingerprint: cacheProfile.systemFingerprint,
          requestProjectionFingerprint: cacheProfile.requestProjectionFingerprint,
          toolSetFingerprint: cacheProfile.toolSetFingerprint,
          compactionBoundary: cacheProfile.compactionBoundary,
          contextCompacted: compaction.compacted,
          withinBudget: compaction.withinBudget,
        },
      )
    }

    return response
  }

  function releaseOwner(): Promise<void> {
    owners = Math.max(0, owners - 1)
    if (owners > 0 || disposed) return cleanup ?? Promise.resolve()
    disposed = true
    cleanup = (async () => {
      try {
        // The scheduler is process-local, but its observer mirrors every transition into the
        // persisted execution graph. Never clear a tree while its root still looks active:
        // after a normal runtime release (or an unexpected early exit) that would leave the
        // restored desktop conversation permanently stuck at “running”.
        const snapshot = scheduler.snapshot(opts.runId)
        const root = snapshot.find((node) => node.path === ROOT_AGENT_PATH)
        if (
          root
          && (root.status === 'queued' || root.status === 'distilling' || root.status === 'running')
        ) {
          const descendants = snapshot.filter((node) => node.path !== ROOT_AGENT_PATH)
          const status = opts.signal.aborted || descendants.some((node) =>
            node.status === 'queued' || node.status === 'distilling' || node.status === 'running')
            ? 'cancelled'
            : descendants.some((node) => node.status === 'failed')
              ? 'failed'
              : descendants.some((node) => node.status === 'cancelled')
                ? 'cancelled'
                : 'done'
          scheduler.markNode(opts.runId, ROOT_AGENT_PATH, status)
        }
        await archive.close()
      } finally {
        ownerSignal.removeEventListener('abort', abortFromOwner)
        unsubscribeScheduler?.()
        delegationStateByChildPath.clear()
        scheduler.clear(opts.runId)
      }
    })()
    return cleanup
  }

  const distillChat = async (
    state: DelegationCallState,
    input: Parameters<SkillDistillChat>[0],
    maxModelCalls: number,
    observe?: CallModelObservation,
  ) => {
    // 蒸馏的消息只有 [system, user]、无任何 tool 条目，两条都在 compactContext 的硬保护范围内，
    // L1~L4 无一有事可做 —— 'child_context_compacted' 结构上永远不会触发。
    // 但 'child_context_over_budget' 在这条路上【是会发生的】：distill 的 user 正文含整份
    // parentTranscript，深树 + 长对话下它自己就能超预算，而这里压不动、只能原样发出去撞 400。
    // 那是最该报警的形态之一（压根压不动），所以 observe 要传。这里按 request 自带的 purpose
    // 与 agentPath 拆成 core / child_brief 两类 lane，避免并发蒸馏被错误聚合。
    const distillPhase: CallModelObservation['phase'] =
      input.purpose === 'core' ? 'distill:core' : 'distill:child_brief'
    const distillObserve = observe
      ? {
          ...observe,
          agentPath: input.agentPath,
          phase: distillPhase,
        }
      : undefined
    const response = await callModel(state, {
      messages: [
        { role: 'system', content: input.system },
        { role: 'user', content: input.user },
      ],
      toolChoice: 'none',
      observe: distillObserve,
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
      `> ${FINISH_REASON_ERRORS[finishReason]}`,
      '> 本 skill 内容不完整，不得当作完整约束执行；缺失部分请回到父 agent 澄清后再动手。',
    ].join('\n')
  }

  async function runChildAgent(args: {
    node: SubagentNodeRecord
    spec: DelegateAgentChildSpec
    context: DelegateAgentCallContext
    archiveBasePath: string
    inheritedSkills: SubagentSkillFile[]
    localSkill: SubagentSkillFile
    state: DelegationCallState
    budget: TreeRuntimeBudget
    toolProfile: SubagentToolProfile
    confirmedTools: readonly string[]
  }): Promise<ChildAgentResult> {
    const {
      node,
      spec,
      context,
      archiveBasePath,
      inheritedSkills,
      localSkill,
      state,
      budget,
      toolProfile,
      confirmedTools,
    } = args
    const modelSelection = createSubagentModelSelection({
      primarySettings: opts.settings,
      parentPath: node.parentPath,
      spec,
      confirmedTools,
    })
    const maxTurnTools = maxTurnToolsForVendor(modelSelection.settings.vendor)
    const allowedToolNames = [...subagentAllowedTools(toolProfile), ...confirmedTools]
    const skillFiles = [...node.inheritedSkillFiles, localSkill.path]
    const skillIds = [...node.inheritedSkillIds, localSkill.skillId]
    const changeSets: ChildChangeSet[] = []
    const executedToolNames: string[] = []
    scheduler.markNode(opts.runId, node.path, 'running', {
      localSkillFiles: [localSkill.path],
      localSkillIds: [localSkill.skillId],
      inheritedSkillFiles: [...node.inheritedSkillFiles],
      inheritedSkillIds: [...node.inheritedSkillIds],
    })
    await archive.recordEvent(context, archiveBasePath, 'child_started', node.path, {
      objective: spec.objective,
      mode: spec.mode,
      modelTier: modelSelection.routeDecision.tier,
      model: modelSelection.settings.model,
      route_reason: modelSelection.routeDecision.reason,
      fallback_count: modelSelection.fallbackCount,
      requiresTemporalNormalization: spec.requiresTemporalNormalization,
      toolProfile,
      confirmedTools,
      skillId: localSkill.skillId,
      inheritedSkillIds: node.inheritedSkillIds,
    })

    const messages: ModelItem[] = [
      {
        role: 'system',
        content: buildChildSystemPrompt({
          node,
          spec,
          inheritedSkills,
          localSkill,
          toolProfile,
          confirmedTools,
          customInstructions: opts.customInstructions,
          environment: opts.environment,
        }),
      },
      { role: 'user', content: buildChildUserPrompt(spec) },
    ]
    // 授权集整体预载（原先只有 evaluator + workspace_read 这一种孩子享受此待遇）。
    // 理由与那条旧注释同源、只是把结论推广到所有孩子：孩子的 maxTurns 默认只有 4，且最后一轮
    // 是合成轮 —— 让它先花一整轮做能力发现，等于砍掉三分之一的产出预算。
    // ★ 与主循环 TK3「禁止预加载」不冲突 ★ ——那条针对的是主 agent 三十多个工具的清单成本；
    //   孩子的 allowedToolNames 在 spawn 时就已收窄到个位数（delegate_only 1 个、
    //   workspace_read 5 个，外加本次委派显式确认的危险工具）。
    // ★ 不放宽任何授权边界 ★ ——预载只是把【已授权】工具的 schema 摆上桌；未授权的工具
    //   既不在这里，也进不了 buildTurnTools（它同样吃 allowedToolNames）。
    // 这也是下面那道闸门能变严（不再拿猜的参数执行）而不伤预算的前提。
    let visible: LoadedTool[] = allowedToolNames.reduce<LoadedTool[]>(
      (tools, name) => appendVisibleTool(tools, name, registry, maxTurnTools - 1),
      [],
    )
    let recentToolNames = visible.map((tool) => tool.name).reverse()
    const maxTurns = spec.maxTurns ?? DEFAULT_CHILD_MAX_TURNS

    const canEscalateFlash = (): boolean => {
      if (confirmedTools.length > 0 || changeSets.length > 0) return false
      // Tool names and returned change sets cannot prove an execution was side-effect free:
      // embedders may replace a same-name tool, and a tool may mutate before throwing. Until the
      // registry exposes immutable capability metadata, fail closed after every tool execution.
      return executedToolNames.length === 0
    }

    const callRoutedChildModel = async (input: {
      messages: ModelItem[]
      tools: ModelFunctionTool[]
      toolChoice: 'auto' | 'none'
      turn: number
    }): Promise<ModelChatResponse> => {
      return callSelectedSubagentModel({
        selection: modelSelection,
        input: {
          primarySettings: opts.settings,
          parentPath: node.parentPath,
          spec,
          confirmedTools,
        },
        signal: opts.signal,
        invoke: (settings) => callModel(
          state,
          {
            messages: input.messages,
            tools: input.tools,
            toolChoice: input.toolChoice,
            settings,
            observe: {
              context,
              archiveBasePath,
              agentPath: node.path,
              turn: input.turn,
              phase: spec.mode === 'evaluator' ? 'evaluator' : 'subagent',
            },
          },
          budget.maxModelCalls,
        ),
        canEscalate: canEscalateFlash,
        onEscalated: async (escalation) => archive.bestEffortRecordEvent(
          context,
          archiveBasePath,
          'child_model_escalated',
          node.path,
          {
            fromModelTier: escalation.fromRoute.tier,
            toModelTier: escalation.toRoute.tier,
            fromModel: escalation.fromModel,
            toModel: escalation.toModel,
            route_reason: escalation.toRoute.reason,
            fallback_count: escalation.fallbackCount,
            trigger: escalation.trigger,
            ...(escalation.error === undefined ? {} : { error: escalation.error }),
          },
        ),
      })
    }

    try {
      for (let turn = 0; turn < maxTurns; turn += 1) {
        // maxTurns 的最后一轮专门用于综合结论。不给工具，防止模型在最后一次调用里继续搜索，
        // 工具执行完却没有下一轮生成最终文本，最终被误报为 exceeded maxTurns。
        const isSynthesisTurn = turn === maxTurns - 1
        const turnMessages: ModelItem[] = isSynthesisTurn
          ? [
              ...messages,
              {
                role: 'user',
                content: spec.expectedOutput
                  ? `工具调查到此结束。现在请仅输出最终结果，严格遵循：${spec.expectedOutput}`
                  : '工具调查到此结束。现在请直接输出最终结论，不要再调用工具。',
              },
            ]
          : messages
        visible = refreshChildVisibleTools(visible, registry, maxTurnTools - 1)
        const tools = isSynthesisTurn
          ? []
          : buildTurnTools(visible, true, {
              allowedToolNames,
              registry,
              vendor: modelSelection.settings.vendor,
              recentToolNames,
            })
        // 子 agent 的既有宿主契约允许 provider/test double 直接返回“已授权但尚未显式加载”
        // 的工具调用。仍在发请求时冻结所有授权工具的注册版本，从而在不改变该契约的前提下
        // 拒绝 MCP 重连后落到同名新实例。
        const requestedRegistrationVersions = new Map(
          allowedToolNames.map((name) => [
            name,
            registry.registrationVersion(name),
          ] as const),
        )
        const response = await callRoutedChildModel({
          messages: turnMessages,
          tools,
          toolChoice: isSynthesisTurn ? 'none' : 'auto',
          turn: turn + 1,
        })
        const msg = response.choices?.[0]?.message
        const toolCalls = narrowToolCalls(msg?.tool_calls)
        await archive.bestEffortRecordTraceItem(context, archiveBasePath, node.path, turn + 1, {
          role: 'assistant',
          content: typeof msg?.content === 'string' ? msg.content : null,
          reasoning_content: msg?.reasoning_content ?? null,
          tool_calls: toolCalls,
        })

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
              await archive.writeText(context, candidate, `${fullText.trim()}\n`)
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
              ? `${FINISH_REASON_ERRORS[finishReason]}；${detail}`
              : FINISH_REASON_ERRORS[finishReason],
          )
        }

        if (toolCalls.length === 0) {
          const summary = firstAssistantText(response) || '子 agent 未返回有效文本。'
          const resultPath = subagentResultPath(archiveBasePath, node.path)
          await archive.writeText(context, resultPath, `${summary.trim()}\n`)
          scheduler.markNode(opts.runId, node.path, 'done', {
            resultFile: resultPath,
            localSkillFiles: [localSkill.path],
            localSkillIds: [localSkill.skillId],
            inheritedSkillFiles: [...node.inheritedSkillFiles],
            inheritedSkillIds: [...node.inheritedSkillIds],
          })
          await archive.recordEvent(context, archiveBasePath, 'child_finished', node.path, {
            status: 'done',
            objective: spec.objective,
            summary,
            resultFile: resultPath,
            skillFiles,
            skillIds,
            modelTier: modelSelection.routeDecision.tier,
            route_reason: modelSelection.routeDecision.reason,
            fallback_count: modelSelection.fallbackCount,
          })
          return {
            path: node.path,
            status: 'done',
            objective: spec.objective,
            summary,
            resultFile: resultPath,
            skillFiles,
            skillIds,
            changeSets,
            modelTier: modelSelection.routeDecision.tier,
            routeReason: modelSelection.routeDecision.reason,
            fallbackCount: modelSelection.fallbackCount,
          }
        }

        messages.push({
          role: 'assistant',
          content: typeof msg?.content === 'string' ? msg.content : null,
          reasoning_content: msg?.reasoning_content ?? null,
          tool_calls: toolCalls,
        })

        const pushToolResult = async (toolCallId: string, content: string): Promise<void> => {
          const item: ModelItem = {
            role: 'tool',
            tool_call_id: toolCallId,
            content,
          }
          messages.push(item)
          await archive.bestEffortRecordTraceItem(context, archiveBasePath, node.path, turn + 1, item)
        }

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
            await pushToolResult(
              toolCall.id,
              JSON.stringify({
                error: parsedArgs.error,
                hint: '请重新发起该工具调用，并确保 arguments 是完整合法的 JSON 对象',
                argumentsPreview: argsPreviewForModel(parsedArgs.raw),
              }),
            )
            continue
          }
          const callArgs = parsedArgs.args
          const expectedRegistrationVersion = requestedRegistrationVersions.get(name)
          const gate = selectToolGate({
            name,
            args: callArgs,
            turnTools: tools,
            isSynthesisTurn,
            isAllowedTool: (toolName) => allowedToolNames.includes(toolName),
            loadSchema: (toolName) => registry.loadSchema(toolName),
            expectedRegistrationVersion,
            registrationVersion: (toolName) => registry.registrationVersion(toolName),
            canExecuteTool: (toolName) => (
              isSubagentWorkspaceReadTool(toolName)
              || isDelegatableDangerousTool(toolName)
              || isSubagentVerificationTool(toolName)
            ),
            delegate: {
              name: DELEGATE_TOOL_NAME,
              path: node.path,
              depth: name === DELEGATE_TOOL_NAME ? agentPathDepth(node.path) : 0,
              maxDepth: budget.maxDepth,
            },
          })
          if (gate.kind === 'schema_request' || gate.kind === 'schema_request_denied') {
            const toolName = typeof callArgs.toolName === 'string' ? callArgs.toolName.trim() : ''
            await archive.recordEvent(context, archiveBasePath, 'child_tool_schema_requested', node.path, {
              toolName: toolName || undefined,
              discovery: !toolName,
            })
            if (gate.kind === 'schema_request_denied') {
              await pushToolResult(
                toolCall.id,
                JSON.stringify(gate.result),
              )
              continue
            }
            if (toolName) {
              const loadedTool = registry.loadSchema(toolName)
              visible = loadedTool
                ? appendVisibleTool(visible, toolName, registry, maxTurnTools - 1)
                : visible
              if (loadedTool) {
                recentToolNames = touchRecentToolName(recentToolNames, toolName, maxTurnTools - 1)
              }
              await pushToolResult(
                toolCall.id,
                JSON.stringify(loadedTool ? toolSchemaLoadedResult(loadedTool) : { error: 'unknown' }),
              )
              continue
            }
            await pushToolResult(
              toolCall.id,
              JSON.stringify(searchToolManifestPage(
                {
                  query: typeof callArgs.query === 'string' ? callArgs.query : undefined,
                  cursor: typeof callArgs.cursor === 'string' ? callArgs.cursor : undefined,
                  limit: typeof callArgs.limit === 'number' ? callArgs.limit : undefined,
                },
                true,
                { registry, allowedToolNames },
              )),
            )
            continue
          }

          // ★ Lazy 闸门：与主循环（modelRun）逐条对齐 ★
          //   判据同样是「本轮实际发给 provider 的 tools」，而不是 registry / allowedToolNames ——
          //   工具不在本轮 tools 里就【不执行】，改把这次调用当作一次 schema 加载：装进 visible，
          //   下一轮起随 tools 长期携带，与 request_tool_schema 的效果逐字一致。
          //   旧行为是「已授权就直接跑」：registry 只做 schema 校验，模型猜的参数只要形状碰对
          //   就会真执行 —— 对 confirmedTools 里的 shell/write 这类危险工具尤其不该如此。
          //   有了上面的授权集预载，正常情况下授权工具本来就在 tools 里，这道闸门只在
          //   「注册态中途变化」这类边角上兜底，不额外消耗孩子的 maxTurns。
          //   合成轮（tools 被有意清空、toolChoice='none'）不适用：那里的「不在 tools 里」表示
          //   能力被主动收回，不是 schema 没加载。
          if (gate.kind === 'schema_autoloaded') {
            const autoloadable = gate.tool
            if (autoloadable) {
              visible = appendVisibleTool(visible, name, registry, maxTurnTools - 1)
              recentToolNames = touchRecentToolName(recentToolNames, name, maxTurnTools - 1)
              await archive.recordEvent(context, archiveBasePath, 'child_tool_schema_requested', node.path, {
                toolName: name,
                discovery: false,
                autoloaded: true,
              })
              await pushToolResult(
                toolCall.id,
                JSON.stringify(gate.result),
              )
              continue
            }
          }

          if (gate.kind === 'registration_changed') {
            await pushToolResult(
              toolCall.id,
              JSON.stringify(gate.result),
            )
            continue
          }

          if (gate.kind === 'delegate') {
            const normalized = normalizeDelegateAgentInput(callArgs)
            if (!normalized.ok) {
              await pushToolResult(toolCall.id, JSON.stringify({ error: normalized.error }))
              continue
            }

            await archive.recordEvent(context, archiveBasePath, 'nested_delegate_requested', node.path, {
              children: normalized.input.children.length,
              maxDepth: budget.maxDepth,
              maxChildren: budget.maxChildren,
            })
            // Nested delegation consumes model/tree budget and may itself perform work. Even when
            // no workspace change is reported, do not automatically replay the parent child on Pro.
            executedToolNames.push(name)
            let nested: DelegateAgentBatchResult | { error: string }
            try {
              const parentConfirmedTools = state.confirmedToolsByPath.get(node.path) ?? []
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
            await pushToolResult(toolCall.id, JSON.stringify(nested))
            observeChangeSets(nested, changeSets)
            continue
          }

          if (gate.kind === 'execute') {
            if (!context.runChildTool) {
              await pushToolResult(
                toolCall.id,
                JSON.stringify({ error: `child tool unavailable: ${name}` }),
              )
              continue
            }
            const startedAt = Date.now()
            let toolResult:
              | { ok: true; data?: unknown; warnings?: string[] }
              | {
                  ok: false
                  error: string
                  code?: string
                  hint?: string
                  retryable?: boolean
                  details?: unknown
                }
            try {
              toolResult = await context.runChildTool(
                name,
                callArgs,
                expectedRegistrationVersion,
              )
            } catch (error) {
              if (isAbortError(error, opts.signal)) throw error
              toolResult = { ok: false, error: toErrorMessage(error) }
            }
            executedToolNames.push(name)
            if (toolResult.ok) observeChangeSets(toolResult.data, changeSets)
            await archive.bestEffortRecordEvent(context, archiveBasePath, 'child_tool_finished', node.path, {
              toolName: name,
              ok: toolResult.ok,
              durationMs: Date.now() - startedAt,
            })
            await pushToolResult(
              toolCall.id,
              JSON.stringify(
                toolResult.ok
                  ? toolResult.warnings?.length
                    ? { data: toolResult.data ?? { ok: true }, warnings: toolResult.warnings }
                    : (toolResult.data ?? { ok: true })
                  : {
                      error: toolResult.error,
                      ...(toolResult.code ? { code: toolResult.code } : {}),
                      ...(toolResult.hint ? { hint: toolResult.hint } : {}),
                      ...(toolResult.retryable !== undefined
                        ? { retryable: toolResult.retryable }
                        : {}),
                      ...(toolResult.details !== undefined
                        ? { details: toolResult.details }
                        : {}),
                    },
              ),
            )
            continue
          }

          await pushToolResult(toolCall.id, JSON.stringify(gate.result))
        }
      }

      throw new Error(`child agent exceeded maxTurns ${maxTurns}`)
    } catch (error) {
      const message = toErrorMessage(error)
      const status = isAbortError(error, opts.signal) ? 'cancelled' : 'failed'
      scheduler.markNode(opts.runId, node.path, status, {
        error: message,
        localSkillFiles: [localSkill.path],
        localSkillIds: [localSkill.skillId],
        inheritedSkillFiles: [...node.inheritedSkillFiles],
        inheritedSkillIds: [...node.inheritedSkillIds],
      })
      await archive.bestEffortRecordEvent(context, archiveBasePath, 'child_finished', node.path, {
        status,
        objective: spec.objective,
        summary: message,
        error: message,
        skillFiles,
        skillIds,
        modelTier: modelSelection.routeDecision.tier,
        route_reason: modelSelection.routeDecision.reason,
        fallback_count: modelSelection.fallbackCount,
      })
      return {
        path: node.path,
        status,
        objective: spec.objective,
        summary: message,
        skillFiles,
        skillIds,
        changeSets,
        modelTier: modelSelection.routeDecision.tier,
        routeReason: modelSelection.routeDecision.reason,
        fallbackCount: modelSelection.fallbackCount,
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
    // A root call owns its complete mutable delegation state. Descendants resolve the state
    // registered for their unique scheduler path, so overlapping root calls cannot inherit one
    // another's quotas, semaphore, tool profile, or dangerous-tool grants.
    const isRootCall = parentPath === ROOT_AGENT_PATH
    const state = isRootCall
      ? createDelegationCallState(input)
      : delegationStateByChildPath.get(parentPath)
    if (!state) throw new Error(`unknown subagent delegation parent path: ${parentPath}`)

    const inheritedBudget = state.budgetByPath.get(parentPath) ?? state.rootBudget
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
    // root 的档位来自宿主，不来自上一次 root 调用：一个 runtime 服务整轮 run 的多次 root 委派
    // （模型的 delegate_agent、submit_stage_result 拉起的验收评估器……），每次都各自决定档位。
    // 曾经在首次调用里把 root 档位锁死，于是「先派 workspace_read 调研、再拉 workspace_verify
    // 评估器」必然被判成加宽而起不来。省略即 delegate_only，不继承上一次 root 调用的档位。
    const inheritedToolProfile = isRootCall
      ? undefined
      : state.toolProfileByPath.get(parentPath) ?? DEFAULT_SUBAGENT_TOOL_PROFILE
    const requestedToolProfile = hasOwn(rawInput, 'toolProfile')
      ? input.toolProfile ?? DEFAULT_SUBAGENT_TOOL_PROFILE
      : inheritedToolProfile ?? DEFAULT_SUBAGENT_TOOL_PROFILE
    if (inheritedToolProfile && !canNarrowSubagentToolProfile(inheritedToolProfile, requestedToolProfile)) {
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
    const pathConfirmedTools = state.confirmedToolsByPath.get(parentPath) ?? []
    const capability = context.dangerousToolCapability
    const capabilityIsScoped = capability
      && capability.sessionId === opts.sessionId
      && capability.runId === opts.runId
      && capability.parentPath === parentPath
      && typeof context.delegationCallId === 'string'
      && capability.delegationCallId === context.delegationCallId
      && capability.toolNames.every(isDelegatableDangerousTool)
      && (parentPath === ROOT_AGENT_PATH || isSubset(capability.toolNames, pathConfirmedTools))
    const inheritedConfirmedTools = capabilityIsScoped ? Array.from(new Set(capability.toolNames)) : []
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

    await archive.ensureArchiveInitialized(context, archiveBasePath)
    scheduler.markNode(opts.runId, parentPath, 'running')
    await archive.recordEvent(context, archiveBasePath, 'delegate_requested', parentPath, {
      children: input.children.map((child) => {
        const childConfirmedTools = child.confirmedTools ?? requestedConfirmedTools
        const route = routeChildModel(opts.settings, parentPath, child, childConfirmedTools)
        return {
          objective: child.objective,
          mode: child.mode,
          expectedOutput: child.expectedOutput,
          modelTier: route.tier,
          route_reason: route.reason,
          requiresTemporalNormalization: child.requiresTemporalNormalization,
          toolProfile: child.toolProfile ?? requestedToolProfile,
          confirmedTools: childConfirmedTools,
        }
      }),
      strategy: input.strategy ?? 'parallel_wait_all',
      maxDepth: budget.maxDepth,
      maxChildren: budget.maxChildren,
      maxConcurrent: budget.maxConcurrent,
      maxTotalNodes: budget.maxTotalNodes,
      maxModelCalls: budget.maxModelCalls,
      totalNodesUsed: state.totalNodesUsed,
      modelCallsUsed: state.modelCallsUsed,
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
      reserveNodes(state, input.children.length, budget.maxTotalNodes)
    } catch (error) {
      const message = toErrorMessage(error)
      if (parentPath === ROOT_AGENT_PATH) {
        scheduler.markNode(opts.runId, parentPath, 'failed', { error: message })
      }
      await archive.bestEffortRecordEvent(context, archiveBasePath, 'delegate_finished', parentPath, {
        status: 'failed',
        children: [],
        error: message,
        budgetUsage: budgetUsage(state),
      })
      try {
        await archive.writeRunArchiveRecord(
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
      reserved = scheduler.reserveChildren({
        treeId: opts.runId,
        sessionId: opts.sessionId,
        delegationCallId: context.delegationCallId,
        parentPath,
        inheritedSkillFiles,
        inheritedSkillIds,
        children: input.children,
      })
    } catch (error) {
      state.totalNodesUsed -= input.children.length
      throw error
    }
    reserved.forEach((node, index) => {
      const spec = input.children[index]
      state.budgetByPath.set(node.path, {
        maxDepth: Math.min(budget.maxDepth, spec.maxDepth ?? budget.maxDepth),
        maxChildren: Math.min(budget.maxChildren, spec.maxChildren ?? budget.maxChildren),
        maxConcurrent: budget.maxConcurrent,
        maxTotalNodes: budget.maxTotalNodes,
        maxModelCalls: budget.maxModelCalls,
      })
      state.toolProfileByPath.set(node.path, spec.toolProfile ?? requestedToolProfile)
      state.confirmedToolsByPath.set(node.path, spec.confirmedTools ?? requestedConfirmedTools)
      delegationStateByChildPath.set(node.path, state)
    })
    const parentSnapshot = scheduler.snapshot(opts.runId).find((node) => node.path === parentPath)
    const parentDispatchIndex = parentSnapshot ? Math.max(1, parentSnapshot.dispatchCounter) : 1
    await archive.recordEvent(context, archiveBasePath, 'children_reserved', parentPath, {
      paths: reserved.map((node) => node.path),
      dispatchCounter: parentDispatchIndex,
      totalNodesUsed: state.totalNodesUsed,
      maxTotalNodes: state.rootBudget.maxTotalNodes,
    })

    for (const node of reserved) {
      scheduler.markNode(opts.runId, node.path, 'distilling')
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
          distillChat(state, request, budget.maxModelCalls, {
            context,
            archiveBasePath,
            agentPath: parentPath,
            turn: 0, // distill 不是「轮」，靠 phase 区分（见 CallModelObservation）。
            phase: 'distill:core',
          }),
      })
    } catch (error) {
      const message = toErrorMessage(error)
      const status = isAbortError(error, opts.signal) ? 'cancelled' : 'failed'
      const children: ChildAgentResult[] = reserved.map((node, index) => {
        scheduler.markNode(opts.runId, node.path, status, { error: message })
        return {
          path: node.path,
          status,
          objective: input.children[index].objective,
          summary: message,
          skillFiles: [...node.inheritedSkillFiles],
          skillIds: [...node.inheritedSkillIds],
          changeSets: [],
          error: message,
        }
      })
      if (parentPath === ROOT_AGENT_PATH) scheduler.markNode(opts.runId, parentPath, status, { error: message })
      await Promise.all(
        children.map((child) =>
          archive.bestEffortRecordEvent(context, archiveBasePath, 'child_finished', child.path, {
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
        await archive.persistTreeSnapshot(context, archiveBasePath, scheduler.snapshot(opts.runId))
        await archive.writeRunArchiveRecord(
          context,
          archiveBasePath,
          'delegated',
          parentPath === ROOT_AGENT_PATH,
        )
      } catch {
        // Keep the distillation/abort error as the primary failure.
      }
      await archive.bestEffortRecordEvent(context, archiveBasePath, 'delegate_finished', parentPath, {
        status,
        children: children.map((child) => ({ path: child.path, status: child.status })),
        error: message,
        budgetUsage: budgetUsage(state),
      })
      throw error
    }

    const allDistilledFiles = [distilled.coreSkill, ...distilled.childSkills]
    await Promise.all(allDistilledFiles.map((skill) => archive.persistSkill(context, archiveBasePath, skill)))
    const parentBefore = scheduler.snapshot(opts.runId).find((node) => node.path === parentPath)
    scheduler.markNode(opts.runId, parentPath, 'running', {
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
        state,
        budget: state.budgetByPath.get(node.path) ?? budget,
        toolProfile: state.toolProfileByPath.get(node.path) ?? requestedToolProfile,
        confirmedTools: state.confirmedToolsByPath.get(node.path) ?? [],
      }),
    )

    const children = await createConcurrencyLimiter(budget.maxConcurrent).runAll(tasks)
    const changeSets: ChildChangeSet[] = []
    children.forEach((child) => collectChangeSets({ changeSets: child.changeSets ?? [] }, changeSets))
    changeSets.sort(
      (left, right) =>
        (changeSetOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER)
        - (changeSetOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER),
    )
    const summary = childSummary(children)
    const status = batchStatus(input.strategy, summary)
    // Tree node status is kept backward-compatible; partial is represented by done parent + failed
    // child nodes, while the batch result/event carries the precise `partial` outcome.
    const parentNodeStatus = status === 'partial' ? 'done' : status
    if (parentPath === ROOT_AGENT_PATH) {
      scheduler.markNode(opts.runId, parentPath, parentNodeStatus)
    }
    const snapshot = scheduler.snapshot(opts.runId)
    await archive.persistTreeSnapshot(context, archiveBasePath, snapshot)
    await archive.writeRunArchiveRecord(
      context,
      archiveBasePath,
      'delegated',
      parentPath === ROOT_AGENT_PATH,
    )
    await archive.recordEvent(context, archiveBasePath, 'delegate_finished', parentPath, {
      status,
      summary,
      children: children.map((child) => ({ path: child.path, status: child.status })),
      skillIds: allDistilledFiles.map((skill) => skill.skillId),
      budgetUsage: budgetUsage(state),
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
      budgetUsage: budgetUsage(state),
      changeSets,
      reversible: changeSets.every((changeSet) => changeSet.reversible),
      children,
    }
  }

  /**
   * ★ 不要给这里的 callModel 传第二参 ★ —— 那个参数是「树累计模型调用上限」，不是
   * 「本次花几次」。低成本提取不是某棵委派树的成员，使用专属的默认调用作用域；
   * 传入 1 会把它的累计调用上限错误收紧为 1，后续 best-effort 调用会静默失效。
   */
  async function runLowCostExtraction(input: {
    systemPrompt: string
    userPrompt: string
    maxOutputTokens?: number
  }): Promise<{ content: string; model: string }> {
    if (disposed) throw new Error('delegate runtime already disposed')
    const systemPrompt = input.systemPrompt.trim()
    const userPrompt = input.userPrompt.trim()
    if (!systemPrompt || !userPrompt) throw new Error('low-cost extraction requires systemPrompt and userPrompt')
    const requestedMaxTokens = Number.isFinite(input.maxOutputTokens)
      ? Math.floor(input.maxOutputTokens!)
      : 1_200
    const response = await callModel(
      lowCostExtractionState ??= createDelegationCallState(),
      {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        tools: [],
        toolChoice: 'none',
        settings: {
          ...opts.settings,
          model: DEEPSEEK_FLASH_MODEL,
          temperature: 0,
          thinking: false,
          max_tokens: Math.max(256, Math.min(requestedMaxTokens, 2_000)),
        },
      },
    )
    const content = firstAssistantText(response)
    if (!content) throw new Error('low-cost extraction returned no text')
    return { content, model: DEEPSEEK_FLASH_MODEL }
  }

  return {
    delegateAgents,
    // 供应商是否支持低成本档在 runtime 构造时就已确定（opts.settings 终生不变）。
    // 只在支持时才挂上这个可选方法，宿主/工具据此判定的「不可用」才是永久性的，
    // 不会被伪装成一个可重试的运行时失败。
    ...(supportsDeepSeekTierRouting(opts.settings) ? { runLowCostExtraction } : {}),
    retain() {
      if (disposed) throw new Error('delegate runtime already disposed')
      owners += 1
    },
    release() {
      void releaseOwner()
    },
    cancel() {
      runtimeController.abort()
    },
    dispose() {
      return releaseOwner()
    },
  }
}
