// 上下文压缩插件（Core 抽离 Stage 1）—— 把 modelRun.ts 内联的压缩逻辑抽成 transformContext 插件。
// ---------------------------------------------------------------------------
// 契约：docs/core-plugin-extraction-blueprint.md §四/§五（PX3 LoopHooks；「上下文压缩 → transformContext」
// 那一行）。本 Stage 只搬这一个关注点——其余五个（模型迁移 / finish_reason 三态 / 循环检测 /
// 危险工具确认 / ask_user 暂停）留到 Stage 2，原样待在 modelRun.ts 的 loop 里，一行不动。
// 【最高铁律】纯结构搬迁，行为零变化：trace 事件名 / attr 名 / 请求体 / compaction 结果都必须
// 与搬迁前逐字一致。
//
// ── 搬迁完成【之后】的有意行为变更（不受上面那条铁律约束，各自单列理由）──
//   · CR1 压缩投影复用（见下方「压缩投影复用」段）：一次压缩的产物在后续 append-only 轮次里
//     直接复用，不再每轮重压。压缩语义本身没变（预算每轮照查、放不下立刻重压），变的是
//     「同一份投影能服务几轮」。新增独立事件 llm.context_projection_reused；
//     llm.context_compacted / llm.context_over_budget 的 attr 集合一个字未动。
//
// ── 与 loop（modelRun.ts）的协作契约（集成时务必对齐；类型见下方 CompactionRequestDraft）──
// LoopHooks 的 RequestDraft 只定义了 `messages`；tools / llmTurn / compaction 是本插件与 loop
// 之间的私有扩展字段——不污染 core 的公共契约（coreCtx.ts / loopHooks.ts / pluginApi.ts 已由
// 上游建好，本文件只 import，不改一行）。loop 侧需要：
//
//   调用 transformContext 之前，往 draft 上挂两样「此刻还没进 store」的瞬时数据：
//     · draft.tools   —— 本轮可见的工具 manifest（buildTurnTools 的结果）。压缩预算要把 tools
//                        的 JSON 大小算进 reservedTokens；tools 是纯瞬时数据，插件自己拿不到，
//                        也不该去猜（ctx.store 里没有它）。省略时按空数组算（reservedTokens 会偏小）。
//     · draft.llmTurn —— 本轮是 loop 里的第几轮（1-based，即旧代码里的 `turn + 1`）。只用于
//                        trace 事件的 llm_turn 属性——旧代码里它是 for 循环的计数器，插件没有
//                        循环计数，必须由 loop 告知。省略时 llm_turn 属性值为 undefined。
//
//   transformContext 跑完后，loop 侧读回：
//     · draft.messages   —— 压缩后的请求体 messages（旧代码里的 `messages = compaction.items`）。
//     · draft.compaction —— 完整压缩结果（ContextCompactionResult）。loop 侧原来直接引用的
//                          `compaction.compacted` / `compaction.withinBudget`（llmSpan 的
//                          context_compacted / context_within_budget 两个 attr）从这里取，
//                          不需要、也不应该重算。
//
//   trace 事件 'llm.context_compacted' / 'llm.context_over_budget' 本插件已经用 ctx.traceEvent
//   发好（attr 名与旧代码逐字相同），loop 侧不需要、也不应该再发一遍。
//
// 移走的符号（原先定义在 modelRun.ts，现在从本文件 import）：
//   MODEL_CONTEXT_WINDOW_TOKENS / VENDOR_CONTEXT_WINDOW_TOKENS / FALLBACK_CONTEXT_WINDOW_TOKENS /
//   DEFAULT_RESERVED_OUTPUT_TOKENS / CONTEXT_SAFETY_MARGIN_RATIO / COST_SOFT_CAP_TOKENS /
//   contextWindowTokens()。compactContext / estimateTokensFromText / DEFAULT_KEEP_RECENT_TURNS
//   仍在 runtime/contextCompaction.ts（未挪动，本文件只 import）——modelRun.ts 若还用
//   estimateTokensFromText 算别的（buildContextStatsSnapshot 那份 role 统计）应继续从那边导入，
//   但 compactContext / DEFAULT_KEEP_RECENT_TURNS 抽完后 modelRun.ts 不再需要直接导入。

import type { ModelFunctionTool, ModelItem } from '@web-agent/ai'
import { sessionsAtom } from '../../../state/rootStore'
import {
  compactContext,
  DEFAULT_KEEP_RECENT_TURNS,
  estimateItemsTokens,
  estimateTokensFromText,
  type ContextCompactionResult,
} from '../../contextCompaction'
import type { CoreCtx } from '../coreCtx'
import type { RequestDraft } from '../loopHooks'
import type { AgentPlugin } from '../pluginApi'

// ---------------------------------------------------------------------------
// 上下文压缩预算（原样从 modelRun.ts 搬来，注释与数值一字未改）
// ---------------------------------------------------------------------------
// 模型上下文窗口（token）—— 压缩预算的分母。刻意「宁小勿大」：估小了只是多压一点（可再生的
// 历史工具正文先被摘要），估大了会直接撞 provider 的硬上限，而那正是压缩本来要防的事。
// 精确匹配 model 名（小写），未知模型退回 vendor 保守默认。上新模型时在这加一行即可。
//
// ★ 数值口径（务必看完再改）★
//   · 只收录官方一手文档明确写着窗口大小的型号；查不到 / 只有二手说法的一律【不进表】，
//     让它落到下面的 vendor 兜底（兜底刻意保守，宁可多压一点也别撞 400）。
//   · 官方文档全程只给缩写标签（"1M" / "200K" / "128K"），没有任何一处给出逐位精确整数。
//     这里按【十进制】换算（1M=1_000_000，1K=1_000）—— 与 DeepSeek 计价页 "per 1M tokens"
//     的单位习惯一致。所以可信的是【量级】，不是个位；真实窗口若按 2 的幂算（1M=1048576、
//     128K=131072）只会比这里的数更大，方向上仍然偏保守，安全。
//   · 来源：
//       DeepSeek  https://api-docs.deepseek.com/quick_start/pricing/ （CONTEXT LENGTH 1M）
//       GLM       https://docs.bigmodel.cn/cn/guide/start/model-overview （模型一览表）
//                 https://docs.bigmodel.cn/cn/guide/models/text/glm-5.2 （详情页独立确认 1M）
export const MODEL_CONTEXT_WINDOW_TOKENS: Record<string, number> = {
  // —— DeepSeek：官方定价页四个型号窗口一律 1M。
  'deepseek-v4-pro': 1_000_000, // DEFAULT_DEEPSEEK_MODEL（deepseek.ts）
  'deepseek-v4-flash': 1_000_000,
  // 旧模型名，官方标注 2026/07/24 15:59 UTC 下线；兼容期内分别被路由到 deepseek-v4-flash 的
  // 非思考 / 思考模式，窗口同为 1M。下线后这两个名字发请求本身就会失败，不是这张表能挽救的事，
  // 留着只为兼容期内别把 1M 的窗口当 64K 用（会毫无必要地把历史压掉）。
  'deepseek-chat': 1_000_000,
  'deepseek-reasoner': 1_000_000,
  // —— GLM：旗舰 5.2 与 glm-4-long 是 1M，5.x/4.7/4.6 系是 200K，4.5-air 系与 4-flash 系是 128K。
  'glm-5.2': 1_000_000, // DEFAULT_GLM_MODEL（glm.ts）
  'glm-5.1': 200_000,
  'glm-5': 200_000,
  'glm-5-turbo': 200_000,
  'glm-4.7': 200_000,
  'glm-4.7-flashx': 200_000,
  'glm-4.7-flash': 200_000,
  'glm-4.6': 200_000,
  'glm-4.5-air': 128_000,
  'glm-4.5-airx': 128_000,
  'glm-4.5-flash': 128_000,
  'glm-4-long': 1_000_000,
  'glm-4-flashx-250414': 128_000,
  'glm-4-flash-250414': 128_000,
}
// vendor 兜底刻意【不】跟着上面调大：这条路径专门伺候「表里没有的 model 名」，包括用户手填的
// 私有部署 / 未来型号 / 拼错的名字。对未知模型乐观估窗口 = 直接撞 provider 硬上限。
export const VENDOR_CONTEXT_WINDOW_TOKENS: Record<string, number> = {
  deepseek: 64_000,
  glm: 128_000,
}
export const FALLBACK_CONTEXT_WINDOW_TOKENS = 64_000
// settings.max_tokens 未设时给输出预留的额度（provider 侧默认上限通常在这个量级）。
export const DEFAULT_RESERVED_OUTPUT_TOKENS = 8_000
// 额外安全余量比例：本地估算对 tool_calls 的 JSON 结构偏乐观，留一档避免「估着没超、实际超了」。
export const CONTEXT_SAFETY_MARGIN_RATIO = 0.08
// 成本软上限 —— 与硬窗口【故意解耦】的第二道压缩触发点。
// 起因：窗口表按官方文档校准到 1M 之后，硬窗口预算 ≈ 910K，压缩几乎永不触发；而在此之前，
// 压缩（当时按 64K 窗口算，约 59K 就触发）一直【同时充当着隐性的成本闸门】。校准窗口是对的
// ——它消除了「本来放得下却被压掉」的浪费——但顺带把这个刹车一起拆了：按 deepseek-v4-pro
// 官方 $0.435/1M cache-miss 输入价，单轮 910K 约 $0.39，长会话每一轮都这个量级，而用户毫无提示。
// 所以压缩预算取 min(硬窗口, 成本软上限)：硬窗口防 400，软上限防账单，两者职责分开。
// 200K ≈ 单轮 $0.087（同价目），且压缩摘掉的是可再生的历史工具正文、不动对话主干。
export const COST_SOFT_CAP_TOKENS = 200_000

// 简介：查该 vendor/model 的上下文窗口 token 数。
export function contextWindowTokens(vendor: string, model: string): number {
  return (
    MODEL_CONTEXT_WINDOW_TOKENS[model.toLowerCase()] ??
    VENDOR_CONTEXT_WINDOW_TOKENS[vendor] ??
    FALLBACK_CONTEXT_WINDOW_TOKENS
  )
}

// 简介：计算一次请求可用于输入上下文的总额度。
// 详情：这是界面展示占用百分比时应使用的分母：先取本地实际执行预算（硬窗口与成本上限较小者），
// 再扣除输出预留与安全余量；不能直接拿 provider 标称的 1M 窗口，否则长窗口模型会把占用比例
// 显示得过小。工具 schema 属于输入的一部分，因此不在这里扣除。
export function contextInputBudgetTokens(
  vendor: string,
  model: string,
  reservedOutputTokens = DEFAULT_RESERVED_OUTPUT_TOKENS,
): number {
  const requestBudget = Math.min(contextWindowTokens(vendor, model), COST_SOFT_CAP_TOKENS)
  return Math.max(
    0,
    requestBudget - reservedOutputTokens - Math.ceil(requestBudget * CONTEXT_SAFETY_MARGIN_RATIO),
  )
}

// modelRun.ts 里同名私有 helper 的逐字复制。不从 modelRun.ts import（会成环——modelRun 要反过来
// import 本插件），孤立成本可忽略（6 行的 try/catch JSON.stringify），换来插件对 modelRun 零依赖。
function stringForStats(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return String(value)
  }
}

// 简介：RequestDraft 的私有扩展字段——本插件与 loop 的协作契约（见文件头）。
// 详情：LoopHooks（上游契约，不可改）里 RequestDraft 只有 `messages`；tools/llmTurn/compaction
//   是本插件需要 loop 额外挂上 / 需要回传给 loop 的瞬时数据，故在插件自己的文件里扩展、
//   loop 侧按需 `as CompactionRequestDraft` 使用，不改动 core 的公共类型。
export interface CompactionRequestDraft extends RequestDraft {
  /** 本轮可见的工具 manifest（供估算 reservedTokens；不会被本插件修改）。省略按空数组算。 */
  tools?: ModelFunctionTool[]
  /** 本轮是 loop 里的第几轮（1-based）。只用于 trace 事件的 llm_turn 属性。 */
  llmTurn?: number
  /** 本插件写回的完整压缩结果，供 loop 侧组 llmSpan attrs（context_compacted / context_within_budget）用。 */
  compaction?: ContextCompactionResult
}

// ---------------------------------------------------------------------------
// 压缩投影复用（CR1）
// ---------------------------------------------------------------------------
// 问题：compactContext 是纯函数，每轮拿【当轮完整 items】从头重算。items 每轮追加，
//   protectedStartIndex 的保护窗口、historyUnits 的切分点随之整体后移，产出的投影逐字不同——
//   对 provider 的前缀缓存来说，这等于每轮把整个 prompt 换一遍。
//   实测（trace 的 cache_epoch_reason，2026-07-27 一天 512 次请求）：
//     · 压缩线【之前】一个 cache_epoch 能撑 28~92 次请求，缓存正常复用；
//     · 越过压缩线【之后】每个 epoch 只剩 1 次请求，reason 恒为 compaction_projection_changed
//       —— 即每轮 17 万 token 全额 cache-miss、零复用，当天 45.3% 的请求栽在这里。
//
// 做法：把上一次真压缩的产物连同【它的输入快照】一起记住。下一轮若同时满足
//   (a) 本轮 items 是那份输入的 append-only 延长，(b) 旧投影 + 新增原文仍在预算内，
//   就直接复用旧投影、把新增条目原样接在后面，不重压。前缀于是逐字不变，provider 整段命中。
//
// ★ 为什么这【不是】「为提高命中率牺牲正确性」（docs/context-caching.md 的禁令）★
//   复用发出去的仍是「完整 system + 压缩后的完整有效历史」：旧投影本身就是一次合法压缩的产物，
//   新增部分是原文，两者拼接仍是合法序列。既没有「只发未缓存的后缀」，也没有跳过压缩——预算
//   每轮照查，放不下立刻回落重压。
//
// ★ 复用不会让本该是原文的内容退化成摘要 ★
//   压缩当轮 keepRecentTurns 保护的最近若干轮，在旧投影里【就是原文】；此后每轮新增的也都是
//   原文。被摘要的只有压缩当轮就已经该摘要的历史部分。所以复用态投影的信息量只会 ≥ 重压一次的
//   结果（重压反而会把「当时受保护、如今已变老」的那几轮一并摘掉）。真正需要重压时，预算检查
//   会把它逼出来。

interface CompactionProjectionEntry {
  /** 产出该投影的输入快照（浅拷贝的引用数组，只用于 append-only 校验，不读内容）。 */
  source: readonly ModelItem[]
  /** 该输入的压缩产物，可直接充当后续轮次的稳定前缀。 */
  projection: ModelItem[]
  /** projection 的精确 token 估算（= 压缩当轮的 estimatedTokensAfter）。 */
  projectionTokens: number
  summarizedToolResults: number
  droppedItems: number
  /** 已被连续复用的轮数，只用于 trace 可观测。 */
  reuseCount: number
}

// 简介：压缩投影复用缓存。由 compactionPlugin 的闭包持有 = per-run（见插件定义处）。
export interface CompactionProjectionCache {
  entry?: CompactionProjectionEntry
}

// 简介：建一个空的投影缓存。生产路径由插件装配时调用；测试可显式建一个来跨轮复用。
export function createCompactionProjectionCache(): CompactionProjectionCache {
  return {}
}

// 简介：校验 tool 协议完整性（CC3）——每条 role:'tool' 之前都得有声明过它 tool_call_id 的 assistant。
// 详情：复用路径的兜底。按理说切点落在 unit 边界上不会产生孤儿（丢弃是整组进行的，而新增条目
//   引用的 tool_call 必然落在压缩当轮的保护窗口内、没被丢），但这条判据便宜——O(条目数)、
//   不做任何序列化——与其依赖上面那段推理，不如每次复用前直接验一遍：不成立就放弃复用、
//   老老实实重压，代价只是白跑一次遍历。
function isToolProtocolIntact(items: readonly ModelItem[]): boolean {
  const declared = new Set<string>()
  for (const item of items) {
    if (item.role === 'assistant') {
      for (const call of item.tool_calls ?? []) declared.add(call.id)
      continue
    }
    if (item.role === 'tool' && !declared.has(item.tool_call_id)) return false
  }
  return true
}

interface ReusedProjection {
  items: ModelItem[]
  tokens: number
  appendedCount: number
  appendedTokens: number
}

// 简介：尝试复用上一轮的压缩投影。返回 undefined = 不能复用，调用方须走完整压缩。
function tryReuseProjection(
  cache: CompactionProjectionCache,
  rawMessages: readonly ModelItem[],
  effectiveBudget: number,
): ReusedProjection | undefined {
  const entry = cache.entry
  if (!entry) return undefined

  // append-only 校验：长度只能增不能减，且前缀逐条【同一引用】。
  // items 是 append-only 的不可变数组，checkpoint 回滚 / revert 会整批换掉对象，引用比较因此
  // 天然能捕获「历史被改写」——不需要额外的版本号或内容指纹，也不会因为「内容碰巧相同」误判。
  const prefixLength = entry.source.length
  if (rawMessages.length < prefixLength) return undefined
  for (let i = 0; i < prefixLength; i += 1) {
    if (rawMessages[i] !== entry.source[i]) return undefined
  }

  // 新增部分按【原文】接在旧投影后面。预算不够就得重压——这正是「不跳过压缩」的落点：
  // 复用只在「压缩结论仍然成立」时才成立。
  const appended = rawMessages.slice(prefixLength)
  const appendedTokens = estimateItemsTokens(appended)
  const total = entry.projectionTokens + appendedTokens
  if (total > effectiveBudget) return undefined

  const items = appended.length > 0 ? [...entry.projection, ...appended] : entry.projection
  if (!isToolProtocolIntact(items)) return undefined

  return { items, tokens: total, appendedCount: appended.length, appendedTokens }
}

// 简介：压缩逻辑本体——从 modelRun.ts 的 runToolLoop 内联代码逐字搬来（组 requestBase 前那段）。
// 详情：读 ctx.root 的会话 settings + draft.tools/llmTurn 算预算，调 compactContext，把结果写回
//   draft.messages/draft.compaction，并按原样通过 ctx.traceEvent 发 llm.context_compacted /
//   llm.context_over_budget（compacted 时发前者；仍超预算时发后者，两者独立、不互斥，与旧代码
//   两个独立 if 一致）。
//   cache 省略时行为与引入投影复用之前逐字一致（每轮重压）——单测据此隔离验「压缩本身」。
export function applyCompaction(
  ctx: CoreCtx,
  draft: CompactionRequestDraft,
  cache?: CompactionProjectionCache,
): void {
  // 会话 settings 来自 ctx.root（跨会话 sessionsAtom），不是 ctx.store——vendor/model/max_tokens
  // 是 SessionMeta 的一部分，随会话存在与否而定。没有 settings（会话已被 drop）就没法算预算，
  // 什么都不做——loop 侧在进入这一轮之前已经过 ghost/stale 守卫，正常路径不会触发这一分支。
  // ★ settings 已是【迁移后】值 ★：migrationPlugin.onRunStart 在 run 启动（早于每轮 transformContext）
  // 就把下线旧名（deepseek-chat/deepseek-reasoner）归一化写回了 sessionsAtom，store 从此是「有效
  // settings」唯一真相源。故这里直接读、【不再二次迁移】——窗口/预算与请求体 / contextStats 天然按
  // 同一个迁移后模型名算，两侧不分叉。唯一 onRunStart 跳过写回的情形是 stale run（isCurrent=false），
  // 其压缩产物本就被其它 stale 守卫丢弃，无可观测差异。
  const settings = ctx.root.getter(sessionsAtom)[ctx.sessionId]?.settings
  if (!settings) {
    // settings 缺失（会话已被 drop）：无法算预算。产出一个「未压缩」no-op 结果，保证 loop 侧
    // draft.compaction 恒有值（下方 modelRun 不再裸断言 `draft.compaction!`）。正常路径进不来——
    // 上游 ghost/stale 守卫已挡；旧内联代码里 meta.settings 恒在、根本没有这一分支。
    draft.compaction = {
      items: draft.messages,
      compacted: false,
      withinBudget: true,
      estimatedTokensBefore: 0,
      estimatedTokensAfter: 0,
      effectiveBudgetTokens: 0,
      summarizedToolResults: 0,
      droppedItems: 0,
    }
    return
  }

  const tools = draft.tools ?? []
  const rawMessages = draft.messages
  const messagesBefore = rawMessages.length

  // 预算取「硬窗口」与「成本软上限」的小者：前者防撞 provider 硬上限，后者防账单失控。
  // 窗口 ≤ 软上限的老模型（如 64K 那批）行为完全不变，软上限只在大窗口模型上生效。
  const contextWindow = contextWindowTokens(settings.vendor, settings.model)
  const budgetTokens = Math.min(contextWindow, COST_SOFT_CAP_TOKENS)
  const reservedTokens =
    estimateTokensFromText(stringForStats(tools)) +
    (settings.max_tokens ?? DEFAULT_RESERVED_OUTPUT_TOKENS) +
    Math.ceil(budgetTokens * CONTEXT_SAFETY_MARGIN_RATIO)

  // 与 compactContext 内部 effectiveBudget 同口径（max(0, maxTokens - reservedTokens)）。
  // 复用路径要在【不调用 compactContext】的前提下自己判预算，所以这里先算一份；两处口径必须
  // 一致，否则会出现「复用判定说放得下、真压缩却认为超了」的分叉。
  const effectiveBudget = Math.max(0, budgetTokens - reservedTokens)

  // ── 复用命中：前缀逐字不变，provider 的 KV cache 整段可用，本轮一次压缩都不做。
  const reused = cache ? tryReuseProjection(cache, rawMessages, effectiveBudget) : undefined
  if (reused && cache?.entry) {
    const entry = cache.entry
    entry.reuseCount += 1
    draft.messages = reused.items
    let before: number | undefined
    draft.compaction = {
      items: reused.items,
      // 投影确实是压缩过的产物——compacted 为真才与 contextStats / llmSpan 的语义对齐。
      compacted: true,
      withinBudget: true,
      // 惰性：复用路径没人非看「未压缩时多大」不可，读到才付这次 O(n) 序列化的钱。
      get estimatedTokensBefore(): number {
        if (before === undefined) before = estimateItemsTokens(rawMessages)
        return before
      },
      estimatedTokensAfter: reused.tokens,
      effectiveBudgetTokens: effectiveBudget,
      summarizedToolResults: entry.summarizedToolResults,
      droppedItems: entry.droppedItems,
    }
    // 与 llm.context_compacted 分开的独立事件：那个的语义是「本轮执行了压缩」，复用轮没有。
    // 有了它才能在 trace 里直接看出「一次压缩摊了几轮」——即这项优化的实际收益。
    ctx.traceEvent('llm.context_projection_reused', {
      llm_turn: draft.llmTurn,
      effective_budget_tk: effectiveBudget,
      projection_tk: entry.projectionTokens,
      appended_tk: reused.appendedTokens,
      est_after_tk: reused.tokens,
      appended_items: reused.appendedCount,
      messages_before: messagesBefore,
      messages_after: reused.items.length,
      reuse_count: entry.reuseCount,
    })
    return
  }

  // keepRecentTurns 必须 >= 1（这里显式用默认值 2）：它保证「最后一条 user 之后的全部条目」
  // 不被丢弃——ask_user / 危险工具确认暂停时那个特意不回填的 tool_call 就靠它活着。
  const compaction = compactContext(rawMessages, {
    maxTokens: budgetTokens,
    reservedTokens,
    keepRecentTurns: DEFAULT_KEEP_RECENT_TURNS,
  })

  // 记住本轮投影供后续轮复用。只缓存「真压过且压回了预算内」的：
  //   · 没压过 —— 下轮粗筛（estimateItemsTokensUpperBound）自会飞快通过，不必占缓存；
  //   · 压完仍超预算 —— 异常态（该开新会话了），复用它只会把异常一路延续下去。
  if (cache) {
    cache.entry =
      compaction.compacted && compaction.withinBudget
        ? {
            source: rawMessages.slice(),
            projection: compaction.items,
            projectionTokens: compaction.estimatedTokensAfter,
            summarizedToolResults: compaction.summarizedToolResults,
            droppedItems: compaction.droppedItems,
            reuseCount: 0,
          }
        : undefined
  }
  // 同一个数组同时喂 contextStats 与请求体——两处必须一致，否则 UI 显示的用量和实际发出去的
  // 对不上。未超预算时 compaction.items 就是 rawMessages 同一引用。
  draft.messages = compaction.items
  draft.compaction = compaction

  // 压缩可见性：只有真压过（或压完仍超）才记，正常轮不刷屏。
  // ★ attr 名刻意避开 "token" 子串（用 _tk 后缀表示 token 估算值）★——
  //   observability/redact.ts 的 SENSITIVE_KEY 正则含 |token|，任何带该子串的 key 会被整个抹成
  //   '[REDACTED]'，数字全看不见就等于没记。
  if (compaction.compacted) {
    ctx.traceEvent('llm.context_compacted', {
      llm_turn: draft.llmTurn,
      context_window_tk: contextWindow,
      // 本轮压缩是被哪一侧逼出来的：window=硬窗口不够，cost_cap=成本软上限先夹住了。
      budget_source: budgetTokens < contextWindow ? 'cost_cap' : 'window',
      budget_tk: budgetTokens,
      reserved_tk: reservedTokens,
      effective_budget_tk: compaction.effectiveBudgetTokens,
      est_before_tk: compaction.estimatedTokensBefore,
      est_after_tk: compaction.estimatedTokensAfter,
      summarized_tool_results: compaction.summarizedToolResults,
      dropped_items: compaction.droppedItems,
      messages_before: messagesBefore,
      messages_after: compaction.items.length,
      within_budget: compaction.withinBudget,
    })
  }
  // 四级降级跑完仍超预算：序列仍然合法，照发不误（不因此中止 run），但要留痕——这基本等于
  // 「该开新会话了」或「最近一轮某条工具结果单条就撑爆窗口」。
  if (!compaction.withinBudget) {
    ctx.traceEvent('llm.context_over_budget', {
      llm_turn: draft.llmTurn,
      effective_budget_tk: compaction.effectiveBudgetTokens,
      est_after_tk: compaction.estimatedTokensAfter,
      hint: '上下文压缩后仍超预算，建议开新会话',
    })
  }
}

// 简介：上下文压缩插件（PX2 AgentPlugin）——装配期把 applyCompaction 注册进 transformContext 槽。
// 详情：RequestDraft 到 CompactionRequestDraft 的 cast 在这里做一次，其余逻辑全在 applyCompaction
//   里（可独立单测，不必每次都经 assemblePlugins 装配）。
export const compactionPlugin: AgentPlugin = (api) => {
  // 投影缓存挂在插件闭包上 = per-run：modelRun 在 runToolLoop 里、进多轮循环【之前】调一次
  // assemblePlugins，于是同一个 run 的所有轮次共享这一份缓存，run 结束即随闭包释放。
  // 天然按 run 隔离（与 loopGuardPlugin 的 per-run 计数同款做法），不需要按 sessionId 分桶，
  // 也不会在隔离 core 实例之间串味。跨 run 重压一次是可接受的——跨 run 必然有新的用户输入，
  // 保护窗口本来就该借这个机会重新取景。
  const cache = createCompactionProjectionCache()
  api.hook('transformContext', (ctx, draft) => {
    applyCompaction(ctx, draft as CompactionRequestDraft, cache)
  })
}
