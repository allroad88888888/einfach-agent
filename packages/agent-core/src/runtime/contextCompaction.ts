// 上下文压缩策略（纯函数）—— 把超预算的 messages 就地瘦身成「仍然合法」的 ModelItem[]。
// ---------------------------------------------------------------------------
// 背景：runToolLoop 每轮把全部 items 重发（TK1，无 continuation blob），长会话必然撞
// context limit。撞墙的表现不是干净报错，而是输出被截断 → tool_calls 的 arguments JSON
// 半截 → parseToolCallArgs 判定坏 JSON、该工具不执行只回填错误结果 → 白烧一轮。故在组 request
// 前先做一次本地压缩。
//
// 设计约束（都是硬的）：
//   · CC1 纯函数：入 ModelItem[] + 预算，出 ModelItem[]。不碰 atom / store / 网络。
//   · CC2 不调 LLM 做摘要。压缩本身位于「故障路径」上，再塞一次网络调用等于给故障路径加
//     故障点（还慢、还可能被同一个 context limit 打回）。一律本地规则压缩。
//   · CC3 tool-call 协议完整性（最容易搞砸的地方）：assistant.tool_calls 与其后 tool_call_id
//     匹配的 role:'tool' 条目是一个不可分割的原子单元。丢弃 assistant 却留下 tool 结果（或
//     反之）会被 OpenAI 兼容接口判为非法，整个 run 报错。故「丢弃」必须整组进行。
//   · CC4 system 恒保留；最近若干轮尽量原样保留；最后一条 user 输入绝不被压缩或丢弃。
//   · CC5 估算口径与 modelRun.buildContextStatsSnapshot 完全一致：逐条
//     estimateTokensFromText(JSON.stringify(item)) 后求和 —— 否则 UI 显示的用量和压缩阈值
//     对不上，调参时会互相打架。
//
// 分级降级（从「最不疼」到「最疼」，逐级施加，每步都复查是否已达标）：
//   L1 摘要历史 tool 结果正文  —— tool 结果通常占 80% 体积且最可再生（大不了让 model 重调）。
//   L2 整组丢弃历史 tool 组    —— 连 assistant(tool_calls) 一起丢，绝不产生孤儿。
//   L3 丢弃历史对话主干        —— user/assistant 文本，system 与最后一条 user 除外。
//   L4 摘要保护窗口内的 tool 结果 —— 仅当历史全压完仍超预算时才动窗口（见下方说明）。
// 四级跑完仍超预算 → 返回「已尽力」的合法序列并置 withinBudget:false，绝不为了凑数字去破坏
// 协议或砍掉最后一条 user。调用方据此决定是否提示用户开新会话。

import type { AssistantItem, ModelItem, ToolItem } from '@web-agent/ai'
import {
  estimateItemTokens,
  estimateItemsTokens,
  estimateItemsTokensUpperBound,
} from './contextCompactionEstimates'
import { stringForStats } from './shared/preview'

export {
  estimateItemTokens,
  estimateItemsTokens,
  estimateItemsTokensUpperBound,
  estimateTokensFromText,
} from './contextCompactionEstimates'

// 摘要占位里的标记字段名。带上它才能做幂等判定（压缩过的结果不再二次包裹），
// UI / 测试也可据此识别「这条是被省略过的历史工具结果」。
export const COMPACTED_TOOL_RESULT_MARKER = '_compacted'

// 默认保护最近 2 轮（一轮 = 以一条 user 起头）。1 轮太激进：model 常需要看上一轮的
// 工具原文来纠错；3 轮以上则在长工具输出下几乎压不动。
export const DEFAULT_KEEP_RECENT_TURNS = 2
export const DEFAULT_TOOL_RESULT_HEAD_CHARS = 200
export const DEFAULT_TOOL_RESULT_TAIL_CHARS = 100

// 摘要占位给 model 的提示语 —— 【按工具能否安全重放分叉】，不能一视同仁。
// 起因：本模块原本只服务主循环，被摘要的多是 read_file / skill_read 这类读操作，
// 「需要完整内容请重新调用该工具」是对的——重调的代价只是再读一次。
// 但它现在也服务子 agent 循环（subagents/runtime.ts），被摘要的对象里多了一类：
// 嵌套 delegate_agent 回填的完整 DelegateAgentBatchResult。对它说「请重新调用该工具」，
// 模型照做就是【重跑一整棵子 agent 子树】——非幂等、再烧一遍 maxTotalNodes / maxModelCalls
// 配额、归档写盘与危险工具的副作用全部重来一遍。写类工具同理，重放会二次改动 workspace。
// 所以对这些工具，占位只陈述「已省略」，绝不建议重新调用。
const REPLAY_SAFE_NOTE = '历史工具结果已省略；需要完整内容请重新调用该工具'
const REPLAY_UNSAFE_NOTE =
  '历史工具结果已省略。该工具有副作用或代价高昂，不要为了拿回这段内容而重新调用它；' +
  '如确需完整内容，请改用只读工具获取，或向用户确认。'

function compactedNoteFor(
  toolName: string | undefined,
  replayUnsafeToolNames: ReadonlySet<string> | undefined,
): string {
  return toolName && replayUnsafeToolNames?.has(toolName) ? REPLAY_UNSAFE_NOTE : REPLAY_SAFE_NOTE
}

// 简介：压缩预算。
// 详情：maxTokens 是「本次请求 messages 允许占的 token 上限」；reservedTokens 是调用方已知
// 会被别处吃掉的额度（tools manifest 的 JSON、给模型输出留的 max_tokens 等），实际生效预算
// = max(0, maxTokens - reservedTokens)。二者分开是为了让调用方直接填「模型上下文窗口」而不必
// 自己做减法。
export interface ContextCompactionBudget {
  maxTokens: number
  reservedTokens?: number
  /**
   * Optional lower target used only after the normal request budget has overflowed.
   * `effectiveBudgetTokens` and `withinBudget` still describe the actual request
   * limit; this merely leaves deliberate room for a subsequent append.
   */
  targetTokens?: number
  keepRecentTurns?: number
  toolResultHeadChars?: number
  toolResultTailChars?: number
  /** Snapshot of registered tools whose result must not recommend replaying the call. */
  replayUnsafeToolNames?: ReadonlySet<string>
}

// 简介：压缩结果。
// 详情：items 是可直接塞进请求体的 messages；未触发压缩时 items 与入参「同一个引用」，
// 调用方可用 `result.items === input` 廉价判断「本轮没动过」。withinBudget:false 表示四级
// 降级跑完仍超预算（极端小预算或单条超大 tool 结果），此时 items 仍然是合法序列。
export interface ContextCompactionResult {
  items: ModelItem[]
  compacted: boolean
  withinBudget: boolean
  estimatedTokensBefore: number
  estimatedTokensAfter: number
  effectiveBudgetTokens: number
  summarizedToolResults: number
  droppedItems: number
}

// ---------------------------------------------------------------------------
// 预扫描粗筛（纯性能优化，零行为影响）
// ---------------------------------------------------------------------------
// 动机：compactContext 是【每轮无条件调用】的，而它第一步的 estimateItemsTokens 要对每条
// message 做一次 JSON.stringify —— 一条 400KB 的 read_file 结果就意味着每轮一次 400KB 的同步
// 序列化，跑在浏览器主线程上。主循环每轮一次尚可忍；但本模块也服务子 agent 循环，而子 agent 是
// 【扇出】执行的（maxConcurrent 默认 4、maxTotalNodes 默认 64），一次 delegate 能叠出几十次
// 这样的全量同步扫描 → UI 掉帧。
//
// 做法：先只读字符串的 .length（O(1)）算出 token 数的【上界】。上界都没超预算 → 精确值必然
// 也没超 → 直接走「未超预算」分支，一次 JSON.stringify 都不做。
//
// ★ 为什么必须是【上界】而不是下界 ★
//   我们想跳过的是「没超预算」的轮次。记精确值 E、粗筛值 P、生效预算 B：
//     · 上界（P ≥ E）：判定 P ≤ B 成立时，有 E ≤ P ≤ B —— 「没超」是被【证明】出来的，
//       跳过安全；P > B 时什么都没证明，老老实实回落到精确计算。
//     · 下界（P ≤ E）：判定 P ≤ B 成立时 E 仍可能 > B —— 该压的轮次被判成不用压，超预算的
//       messages 直接发出去撞 provider 的 context limit（400）。
//   结论：粗筛只有资格说「肯定没超」，永远无权说「肯定超了」。
//
// ★ 上界推导（每一步都必须严格成立，不能「差不多」）★
//   记某条 item 的 S = JSON.stringify(item)，则 estimateTokensFromText(S) = ceil(cjk/1.8 + other/4)。
//   第 1 步 —— 把「输出字符的代价」折回「输入字符」。逐类看输入串里的一个字符 c 最多贡献多少：
//     · c 是 CJK（[㐀-鿿豈-﫿]）：JSON.stringify 不转义非 ASCII，原样输出 1 个
//       CJK 字符 → 贡献 1/1.8 ≈ 0.556 token。
//     · c 不是 CJK：最多被转义成 6 个字符（控制字符 / 孤立代理项 → \uXXXX），而转义产物
//       【全是 ASCII】，必然落进 other 桶 → 贡献 ≤ 6/4 = 1.5 token。
//     取两者之大 → 每个输入字符贡献 ≤ 1.5 token，即 PRESCAN_TOKENS_PER_CHAR。
//     ⚠ 这里【不能】把「6 倍转义」和「CJK 的 1/1.8」乘起来（6/1.8 = 3.33）：转义产物是 ASCII，
//       不可能同时又是 CJK，两个最坏情形互斥。分类讨论比连乘既更紧、又同样严格。
//   第 2 步 —— JSON 骨架（{ } [ ] " : , 键名、null/数字字面量）也要计入输入字符：它们同样是
//     ASCII，贡献 1/4 ≤ 1.5，用同一个系数覆盖即可。rawCharsOf 给每个容器/键/字面量都留了
//     足量的常数额度（宁可多算，多算只会让粗筛更保守）。
//   第 3 步 —— ceil 的零头：before = Σ ceil(x_i) ≤ Σ (x_i + 1) = Σ x_i + n（n = 条目数）。
//   合并即 upperBound = ceil(1.5 × totalRawChars) + n ≥ before。∎
//
// 关于余量：三个来源的松弛度差别很大，改动时要拎清哪个才是真的承重墙。
//   · 常数项余量（骨架、引号、字面量额度、上面那个 +n）——每条 message 三四十 token 起，
//     且【不随正文长度增长】。它们互相冗余：单独删掉任何一项，剩下的也兜得住。
//     其中 +n 严格说已被骨架余量覆盖，保留它只是为了让第 3 步的推导自身闭合、
//     不必依赖「骨架一定有余量」这个额外论证。
//   · 每字符系数 1.5 —— 唯一【随正文长度线性放大】的项，也就是唯一的承重墙。
//     正文一大，常数余量就被摊薄到可忽略，安全性全靠它。所以它是理论最小值，
//     一格都不能再往下调（单测 contextCompaction.test.ts 里有专门摊薄常数余量的用例盯着它）。

// ---------------------------------------------------------------------------
// 单元切分（CC3 的载体）
// ---------------------------------------------------------------------------
// 把线性 messages 切成「原子单元」：
//   · system   —— 永不丢弃、永不改写。
//   · backbone —— user / 不带 tool_calls 的 assistant，即对话主干。
//   · tool_group —— assistant(tool_calls) + 其后 id 匹配的连续 role:'tool' 条目。
// 关键：丢弃只能以 unit 为粒度，这样「assistant 的 tool_calls」和「它的 tool 结果」永远同生共死。
// 注意 tool_group 允许「结果条数 < tool_calls 条数」：ask_user / 危险工具确认暂停时，runToolLoop
// 会特意留一个 tool_call 不回填等 resume 补。整组保留即可，不要试图去补齐或裁掉。

type UnitKind = 'system' | 'backbone' | 'tool_group'

interface ContextUnit {
  kind: UnitKind
  indices: number[]
  toolIndices: number[]
}

function assistantToolCallIds(item: AssistantItem): Set<string> {
  return new Set((item.tool_calls ?? []).map((call) => call.id))
}

function buildUnits(items: readonly ModelItem[]): ContextUnit[] {
  const units: ContextUnit[] = []
  let i = 0

  while (i < items.length) {
    const item = items[i]

    if (item.role === 'assistant' && item.tool_calls && item.tool_calls.length > 0) {
      const ids = assistantToolCallIds(item)
      const unit: ContextUnit = { kind: 'tool_group', indices: [i], toolIndices: [] }
      let j = i + 1
      while (j < items.length) {
        const next = items[j]
        if (next.role !== 'tool' || !ids.has(next.tool_call_id)) break
        unit.indices.push(j)
        unit.toolIndices.push(j)
        j += 1
      }
      units.push(unit)
      i = j
      continue
    }

    if (item.role === 'tool') {
      // 孤儿 tool（入参本身就非法，或 id 对不上）。我们不负责修好它，但绝不能因为「单独丢它」
      // 或「单独留它」而把问题放大：挂到前一个单元上同生共死；实在没有前序单元就自成一格。
      const last = units[units.length - 1]
      if (last) {
        last.indices.push(i)
        last.toolIndices.push(i)
      } else {
        units.push({ kind: 'backbone', indices: [i], toolIndices: [i] })
      }
      i += 1
      continue
    }

    units.push({ kind: item.role === 'system' ? 'system' : 'backbone', indices: [i], toolIndices: [] })
    i += 1
  }

  return units
}

// 保护窗口起点：倒数第 keepRecentTurns 条 user 的下标（一轮以 user 起头）。
// user 数量不足 keepRecentTurns 时退化为「第一条 user 起全保护」；完全没有 user 时返回
// items.length（无轮次可保护，全部可压 —— 只有 system 和最后一条 user 的硬保护仍生效）。
function protectedStartIndex(items: readonly ModelItem[], keepRecentTurns: number): number {
  const userIndices: number[] = []
  for (let i = 0; i < items.length; i += 1) {
    if (items[i].role === 'user') userIndices.push(i)
  }
  if (userIndices.length === 0) return items.length
  const keep = Math.max(1, keepRecentTurns)
  const pick = Math.max(0, userIndices.length - keep)
  return userIndices[pick]
}

function lastUserIndex(items: readonly ModelItem[]): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i].role === 'user') return i
  }
  return -1
}

// ---------------------------------------------------------------------------
// tool 结果摘要
// ---------------------------------------------------------------------------

function parsePayload(content: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(content)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

// 成功/失败判定：工具结果统一由 modelRun.appendMappedToolResult 序列化，失败形如 {"error": ...}。
// 非 JSON 正文（少数工具直接回文本）无从判定 → 'unknown'，靠头尾预览把信息留给 model。
function toolResultStatus(payload: Record<string, unknown> | undefined): 'ok' | 'error' | 'unknown' {
  if (!payload) return 'unknown'
  return 'error' in payload && payload.error ? 'error' : 'ok'
}

// 简介：把一条 tool 结果正文压成简短占位摘要。
// 详情：保留工具名、成功/失败、原始长度、正文头尾若干字符。返回 undefined 表示「不该压」——
//   三种情况：已经压过（幂等）、正文短到头尾就覆盖全部（压了没意义）、占位反而更长（压了变胖）。
//   最后一条尤其重要：压缩永远不允许把上下文变大，否则分级降级可能越压越糟。
function summarizeToolResultContent(
  content: string,
  toolName: string | undefined,
  headChars: number,
  tailChars: number,
  replayUnsafeToolNames: ReadonlySet<string> | undefined,
): string | undefined {
  if (!content) return undefined

  const payload = parsePayload(content)
  if (payload && payload[COMPACTED_TOOL_RESULT_MARKER] === true) return undefined

  const head = Math.max(0, headChars)
  const tail = Math.max(0, tailChars)
  if (content.length <= head + tail) return undefined

  const placeholder = stringForStats({
    [COMPACTED_TOOL_RESULT_MARKER]: true,
    tool: toolName ?? 'unknown',
    status: toolResultStatus(payload),
    chars: content.length,
    head: content.slice(0, head),
    tail: tail > 0 ? content.slice(content.length - tail) : '',
    note: compactedNoteFor(toolName, replayUnsafeToolNames),
  })

  return placeholder.length < content.length ? placeholder : undefined
}

// tool_call_id → 工具名。整表扫一遍建好，孤儿 tool 也能查到名字。
function toolNameByCallId(items: readonly ModelItem[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const item of items) {
    if (item.role !== 'assistant' || !item.tool_calls) continue
    for (const call of item.tool_calls) map.set(call.id, call.function.name)
  }
  return map
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

// 简介：构造「未超预算」的返回值（items 原样、compacted:false）。
// 详情：粗筛跳过路径与精确路径【共用这一个构造器】—— 两条路径的返回值因此逐字段同构，
//   不存在「跳过时少填了什么字段」的可能。
//   estimatedTokensBefore / After 做成惰性 getter：粗筛跳过时它俩还没算过，读到才现算并缓存。
//   取值与精确路径完全一致（都等于 estimateItemsTokens(items)），只是把那次 O(n) 序列化推迟到
//   「真有人要看」为止 —— 而调用方（modelRun 的 llm.context_compacted 埋点）只在 compacted 为真
//   时才读这两个数，未压缩的正常轮次谁都不看，于是这次序列化在生产路径上根本不会发生。
function underBudgetResult(
  items: readonly ModelItem[],
  effectiveBudget: number,
  knownBefore?: number,
): ContextCompactionResult {
  let cached = knownBefore
  const exact = (): number => {
    if (cached === undefined) cached = estimateItemsTokens(items)
    return cached
  }
  return {
    items: items as ModelItem[],
    compacted: false,
    withinBudget: true,
    get estimatedTokensBefore(): number {
      return exact()
    },
    get estimatedTokensAfter(): number {
      return exact()
    },
    effectiveBudgetTokens: effectiveBudget,
    summarizedToolResults: 0,
    droppedItems: 0,
  }
}

// 简介：按预算压缩 messages，返回仍然合法的 ModelItem[]（CC1~CC5）。
// 详情：未超预算时原样返回入参引用（compacted:false）。超预算时按 L1→L4 逐级降级，每处理一个
//   单位就复查一次总量，够了立刻停手 —— 保证「只压到刚好达标」而不是一压到底。
//   摘要（L1/L4）逐条施加而丢弃（L2/L3）必须整组：摘要只改 content、不改变条目的存在性，
//   assistant.tool_calls ↔ tool_call_id 的配对关系纹丝不动，因此逐条安全；丢弃会让条目消失，
//   只要不整组就必然产生孤儿（CC3）。
export function compactContext(
  items: readonly ModelItem[],
  budget: ContextCompactionBudget,
): ContextCompactionResult {
  const effectiveBudget = Math.max(0, (budget.maxTokens || 0) - (budget.reservedTokens ?? 0))
  const requestedTarget = budget.targetTokens ?? effectiveBudget
  const targetBudget = Number.isFinite(requestedTarget)
    ? Math.min(effectiveBudget, Math.max(0, requestedTarget))
    : effectiveBudget

  // ① 廉价粗筛：token 上界都没超预算 → 精确值必然也没超（推导见 estimateItemsTokensUpperBound
  //    上方注释），直接走「未超预算」分支，一次序列化都不做。绝大多数轮次走这条。
  if (estimateItemsTokensUpperBound(items) <= effectiveBudget) {
    return underBudgetResult(items, effectiveBudget)
  }

  // ② 粗筛只说了「可能超」，什么都没证明 —— 这时才付精确估算的钱。
  const before = estimateItemsTokens(items)

  // 未超预算 —— 原样返回同一引用，调用方可用引用相等判断「没动过」。
  if (before <= effectiveBudget) {
    return underBudgetResult(items, effectiveBudget, before)
  }

  const headChars = budget.toolResultHeadChars ?? DEFAULT_TOOL_RESULT_HEAD_CHARS
  const tailChars = budget.toolResultTailChars ?? DEFAULT_TOOL_RESULT_TAIL_CHARS
  const keepRecentTurns = budget.keepRecentTurns ?? DEFAULT_KEEP_RECENT_TURNS

  const units = buildUnits(items)
  const boundary = protectedStartIndex(items, keepRecentTurns)
  const lastUser = lastUserIndex(items)
  const nameByCallId = toolNameByCallId(items)

  // 逐条的可变工作区 + 增量记账（避免每步 O(n) 重算全量 token）。
  const working: (ModelItem | undefined)[] = items.slice()
  const tokens: number[] = items.map((item) => estimateItemTokens(item))
  let total = tokens.reduce((sum, value) => sum + value, 0)
  let summarizedToolResults = 0
  let droppedItems = 0

  // 触发压缩后可以收敛到比请求硬预算更低的目标，给下一轮 append 留出余量；
  // `withinBudget` 仍只按实际请求预算判定，不能把「没达到优化目标」误报成请求超限。
  const done = (): boolean => total <= targetBudget

  const replaceAt = (index: number, item: ModelItem): void => {
    const next = estimateItemTokens(item)
    working[index] = item
    total += next - tokens[index]
    tokens[index] = next
  }

  const dropAt = (index: number): void => {
    if (working[index] === undefined) return
    working[index] = undefined
    total -= tokens[index]
    tokens[index] = 0
    droppedItems += 1
  }

  // system 恒保护；最后一条 user 恒保护；boundary 之后（最近若干轮）默认保护。
  const isProtectedUnit = (unit: ContextUnit): boolean => {
    if (unit.kind === 'system') return true
    return unit.indices.some((index) => index >= boundary || index === lastUser)
  }

  const summarizeToolIndex = (index: number): void => {
    const item = working[index]
    if (!item || item.role !== 'tool') return
    const summary = summarizeToolResultContent(
      item.content,
      nameByCallId.get(item.tool_call_id),
      headChars,
      tailChars,
      budget.replayUnsafeToolNames,
    )
    if (summary === undefined) return
    const next: ToolItem = { ...item, content: summary }
    replaceAt(index, next)
    summarizedToolResults += 1
  }

  const historyUnits = units.filter((unit) => !isProtectedUnit(unit))

  // L1：摘要历史 tool 结果正文。最先动它是因为 tool 结果体积大、可再生性最强 ——
  // model 真需要原文时可以重新调一次工具，而对话主干丢了就再也回不来了。
  for (const unit of historyUnits) {
    for (const index of unit.toolIndices) {
      if (done()) break
      summarizeToolIndex(index)
    }
    if (done()) break
  }

  // L2：整组丢弃历史 tool 组（assistant(tool_calls) 与其全部 tool 结果同生共死，CC3）。
  if (!done()) {
    for (const unit of historyUnits) {
      if (done()) break
      if (unit.kind !== 'tool_group') continue
      for (const index of unit.indices) dropAt(index)
    }
  }

  // L3：丢弃历史对话主干（system / 最后一条 user 已被 isProtectedUnit 挡在 historyUnits 之外）。
  // 这一级是应急手段：主干丢了 model 会失忆，但总好过整个请求被 context limit 打回。
  if (!done()) {
    for (const unit of historyUnits) {
      if (done()) break
      if (unit.kind !== 'backbone') continue
      for (const index of unit.indices) dropAt(index)
    }
  }

  // L4：历史全压完仍超预算 —— 说明保护窗口自己就撑爆了（典型：最近一轮读了个超大文件）。
  // 此时「原样保留最近若干轮」和「请求能发出去」二选一，只能选后者：动窗口内的 tool 结果正文，
  // 但仍然不丢弃任何条目、不碰最后一条 user、不碰 system —— 序列永远合法（CC4 的底线）。
  if (!done()) {
    for (const unit of units) {
      if (done()) break
      if (unit.kind === 'system') continue
      for (const index of unit.toolIndices) {
        if (done()) break
        summarizeToolIndex(index)
      }
    }
  }

  const compactedItems: ModelItem[] = []
  for (const item of working) {
    if (item !== undefined) compactedItems.push(item)
  }

  return {
    items: compactedItems,
    compacted: summarizedToolResults > 0 || droppedItems > 0,
    withinBudget: total <= effectiveBudget,
    estimatedTokensBefore: before,
    estimatedTokensAfter: total,
    effectiveBudgetTokens: effectiveBudget,
    summarizedToolResults,
    droppedItems,
  }
}
