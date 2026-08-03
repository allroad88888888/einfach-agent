// compactionPlugin 隔离测——不经 modelRun，直接给假 CoreCtx + draft 验证 transformContext 槽。
// ---------------------------------------------------------------------------
// 覆盖：
//   · 未超预算：draft.messages 原样保留（同引用）、不发任何压缩 trace 事件。
//   · 超预算且压完仍超（reservedTokens 吃光预算）：draft.messages 的历史 tool 结果被摘要，
//     'llm.context_compacted' / 'llm.context_over_budget' 两个事件都发，attrs 与旧公式逐字对齐
//     （含完整 key 集合核对，防止 attr 改名/漏发）。
//   · 超预算但压完回到预算内：只发 'llm.context_compacted'，不发 'llm.context_over_budget'
//     （防「不管 withinBudget 是什么都发 over_budget」这类变异）。
//   · 会话已 ghost（root 查不到 settings）：什么都不做，不抛错。
//   · tools/llmTurn 缺省时的兜底行为（空数组 / undefined 透传)。
// fixture 正文刻意 > 300 字符（4000+ 字符的 tool 结果），否则 compactContext 的 L1 摘要判定
// "压了反而变胖"会拒绝生效、假绿——上一轮踩过的坑（见 summarizeToolResultContent 的头尾覆盖判定）。

import { describe, expect, it, vi } from 'vitest'
import { createStore } from '@einfach/core'

import { contextWindowTokens, type AssistantItem, type ModelItem, type ToolItem, type UserItem } from '@web-agent/ai'
import { sessionsAtom } from '../../../state/rootStore'
import type { ModelSettings, SessionMeta } from '../../../state/core.type'
import { estimateTokensFromText } from '../../contextCompaction'
import { makeCoreCtx, type CoreCtx } from '../coreCtx'
import { assemblePlugins } from '../pluginApi'
import {
  applyCompaction,
  compactionPlugin,
  CONTEXT_SAFETY_MARGIN_RATIO,
  COST_SOFT_CAP_TOKENS,
  DEFAULT_RESERVED_OUTPUT_TOKENS,
  contextInputBudgetTokens,
  type CompactionRequestDraft,
} from './compactionPlugin'

// 只需要 .settings——与 coreCtx.test.ts 的 fakeMeta 同款「最小可信 fake + 强转」写法。
function fakeMeta(settings: ModelSettings): SessionMeta {
  return { settings } as unknown as SessionMeta
}

function fakeCtx(settings: ModelSettings | undefined, traceEvent = vi.fn()): { ctx: CoreCtx; traceEvent: ReturnType<typeof vi.fn> } {
  const root = createStore()
  if (settings) root.setter(sessionsAtom, { s1: fakeMeta(settings) })
  const ctx = makeCoreCtx({
    sessionId: 's1',
    runId: 'r1',
    signal: new AbortController().signal,
    store: createStore(),
    root,
    traceEvent,
  })
  return { ctx, traceEvent }
}

function sysItem(content: string): ModelItem {
  return { role: 'system', content }
}
function userItem(content: string): UserItem {
  return { role: 'user', content }
}
function assistantWithToolCall(): AssistantItem {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'c1', type: 'function', function: { name: 'skill_search', arguments: '{}' } }],
  }
}
function toolResult(content: string): ToolItem {
  return { role: 'tool', tool_call_id: 'c1', content }
}

describe('contextInputBudgetTokens', () => {
  it('大窗口模型按本地 200K 请求预算扣除输出预留和安全余量，而非按标称 1M', () => {
    expect(contextInputBudgetTokens('deepseek', 'deepseek-v4-pro')).toBe(176_000)
  })
})

// 一段「第一轮工具结果超大 + 第二轮起头」的 messages —— 唯一的体积来源是 bigContent，
// 其余条目都很小，方便据此推理压缩后 estimatedTokensAfter 会落在哪。
function turnWithBigToolResult(bigContent: string): ModelItem[] {
  return [
    sysItem('系统指令'),
    userItem('第一轮'),
    assistantWithToolCall(),
    toolResult(bigContent),
    { role: 'assistant', content: '第一轮答复' },
    userItem('第二轮'),
  ]
}

// 与 modelRun.ts 的 stringForStats 同款（compactionPlugin.ts 内部私有，未导出，测试里独立重算
// reservedTokens 时复刻同一口径：JSON.stringify 空数组 === '[]'）。
const EMPTY_TOOLS_STATS = '[]'

describe('compactionPlugin —— 未超预算', () => {
  it('draft.messages 原样保留（同引用）、compaction 标记为未压缩、不发任何压缩事件', async () => {
    // 不设 max_tokens（走 DEFAULT_RESERVED_OUTPUT_TOKENS 兜底）：effectiveBudget 留足够余量，
    // 与另外两个用例故意用 max_tokens 把预算吃光的场景区分开——这里就是要「显然没超」。
    const settings: ModelSettings = { vendor: 'deepseek', model: 'x' }
    const { ctx, traceEvent } = fakeCtx(settings)
    const original: ModelItem[] = [sysItem('系统指令'), userItem('你好')]
    const draft: CompactionRequestDraft = { messages: original, tools: [], llmTurn: 1 }

    const hooks = assemblePlugins([compactionPlugin])
    await hooks.transformContext?.(ctx, draft)

    expect(draft.messages).toBe(original) // compactContext 的 CC 约定：未压缩返回同一引用
    expect(draft.compaction?.compacted).toBe(false)
    expect(draft.compaction?.withinBudget).toBe(true)
    expect(traceEvent).not.toHaveBeenCalled()
  })
})

describe('compactionPlugin —— 超预算（reservedTokens 吃光预算，压完仍超）', () => {
  it('历史 tool 结果被摘要；两个事件都发，attrs 与旧公式逐字对齐（含完整 key 集合）', async () => {
    // 复刻 modelRun.test.ts 的「cc1」用例：model 名故意用表里查不到的 'x'（落到 vendor 兜底
    // 64_000，不与官方窗口表的具体数值绑定），max_tokens 把预算吃光 → 必然触发压缩。
    const settings: ModelSettings = { vendor: 'deepseek', model: 'x', max_tokens: 63_500 }
    const { ctx, traceEvent } = fakeCtx(settings)
    const bigContent = JSON.stringify({ data: 'x'.repeat(4000) })
    expect(bigContent.length).toBeGreaterThan(300) // 上一轮的坑：fixture 太短压不动会假绿
    const messages = turnWithBigToolResult(bigContent)
    const draft: CompactionRequestDraft = {
      messages,
      tools: [],
      llmTurn: 7,
      replayUnsafeToolNames: new Set(['skill_search']),
    }

    const hooks = assemblePlugins([compactionPlugin])
    await hooks.transformContext?.(ctx, draft)

    // draft.messages 确实被换过一份新数组，且历史 tool 结果被压成带 _compacted 标记的占位。
    expect(draft.messages).not.toBe(messages)
    const compactedTool = draft.messages.find((m): m is ToolItem => m.role === 'tool')
    expect(compactedTool).toBeDefined()
    expect(compactedTool?.content).toContain('_compacted')
    expect(compactedTool?.content).toContain('不要为了拿回这段内容而重新调用')
    expect(compactedTool!.content.length).toBeLessThan(bigContent.length)

    // 独立按文档里写明的同一份公式重算预算（不调用 applyCompaction 本身)，核对两处 trace 的
    // attrs 与之逐字一致——这样才能测出「插件真的照公式算」而不是随手编了个数字。
    const contextWindow = contextWindowTokens(settings.vendor, settings.model)
    expect(contextWindow).toBe(64_000) // 'x' 查不到 descriptor → vendor 兜底
    const budgetTokens = Math.min(contextWindow, COST_SOFT_CAP_TOKENS)
    const reservedTokens =
      estimateTokensFromText(EMPTY_TOOLS_STATS) +
      (settings.max_tokens ?? DEFAULT_RESERVED_OUTPUT_TOKENS) +
      Math.ceil(budgetTokens * CONTEXT_SAFETY_MARGIN_RATIO)
    expect(reservedTokens).toBeGreaterThan(budgetTokens) // 断言本用例确实把预算吃到了负数

    const compaction = draft.compaction
    expect(compaction).toBeDefined()
    expect(compaction?.withinBudget).toBe(false) // 预算被吃光到 0，压完仍超
    expect(compaction?.summarizedToolResults).toBeGreaterThan(0)
    expect(compaction?.estimatedTokensAfter).toBeLessThan(compaction!.estimatedTokensBefore)

    expect(traceEvent).toHaveBeenCalledWith('llm.context_compacted', {
      llm_turn: 7,
      context_window_tk: contextWindow,
      budget_source: 'window', // budgetTokens === contextWindow（64_000 min 200_000）→ 不是 cost_cap
      budget_tk: budgetTokens,
      reserved_tk: reservedTokens,
      effective_budget_tk: compaction!.effectiveBudgetTokens,
      est_before_tk: compaction!.estimatedTokensBefore,
      est_after_tk: compaction!.estimatedTokensAfter,
      summarized_tool_results: compaction!.summarizedToolResults,
      dropped_items: compaction!.droppedItems,
      messages_before: messages.length,
      messages_after: draft.messages.length,
      dynamic_tail_items: 0, // 本用例没传 dynamicTailCount → 尾巴为空，压缩作用于全部消息
      within_budget: false,
    })
    // key 集合完整性：防止「值凑巧对了但漏发/改名了某个 attr」这类变异逃过上面的 toHaveBeenCalledWith
    // （toHaveBeenCalledWith 对多余/缺失字段一样会失败，这里再显式核对一次 key 名单，便于阅读意图）。
    const [, firstAttrs] = traceEvent.mock.calls[0] as [string, Record<string, unknown>]
    expect(Object.keys(firstAttrs).sort()).toEqual(
      [
        'budget_source',
        'budget_tk',
        'context_window_tk',
        'dropped_items',
        'effective_budget_tk',
        'est_after_tk',
        'est_before_tk',
        'dynamic_tail_items',
        'llm_turn',
        'messages_after',
        'messages_before',
        'reserved_tk',
        'summarized_tool_results',
        'within_budget',
      ].sort(),
    )

    expect(traceEvent).toHaveBeenCalledWith('llm.context_over_budget', {
      llm_turn: 7,
      effective_budget_tk: compaction!.effectiveBudgetTokens,
      est_after_tk: compaction!.estimatedTokensAfter,
      hint: '上下文压缩后仍超预算，建议开新会话',
    })
    expect(traceEvent).toHaveBeenCalledTimes(2)
  })
})

describe('compactionPlugin —— 超预算但压完回到预算内', () => {
  it('只发 llm.context_compacted，不发 llm.context_over_budget', async () => {
    // max_tokens 给得很小（reservedTokens 很小），effectiveBudget 很宽裕；靠一条巨大的历史
    // tool 结果把 before 顶过 effectiveBudget，L1 摘要（该结果几乎是全部体积来源）足以把
    // after 拉回预算内 —— compacted:true 且 withinBudget:true 同时成立的唯一组合。
    const settings: ModelSettings = { vendor: 'deepseek', model: 'x', max_tokens: 100 }
    const { ctx, traceEvent } = fakeCtx(settings)
    const bigContent = JSON.stringify({ data: 'x'.repeat(400_000) })
    const messages = turnWithBigToolResult(bigContent)
    const draft: CompactionRequestDraft = { messages, tools: [], llmTurn: 2 }

    await assemblePlugins([compactionPlugin]).transformContext?.(ctx, draft)

    expect(draft.compaction?.compacted).toBe(true)
    expect(draft.compaction?.withinBudget).toBe(true)
    expect(traceEvent).toHaveBeenCalledWith('llm.context_compacted', expect.objectContaining({ llm_turn: 2 }))
    expect(traceEvent).not.toHaveBeenCalledWith('llm.context_over_budget', expect.anything())
    expect(traceEvent).toHaveBeenCalledTimes(1)
  })
})

describe('compactionPlugin —— 会话已 ghost（root 查不到 settings）', () => {
  it('settings 缺失：messages 原样、不发事件、且写一个 no-op 结果（下游不再裸断言崩）', async () => {
    const { ctx, traceEvent } = fakeCtx(undefined)
    const original: ModelItem[] = [sysItem('x'), userItem('y')]
    const draft: CompactionRequestDraft = { messages: original, tools: [], llmTurn: 1 }

    await expect(assemblePlugins([compactionPlugin]).transformContext?.(ctx, draft)).resolves.toBeUndefined()

    expect(draft.messages).toBe(original)
    expect(traceEvent).not.toHaveBeenCalled()
    // ★ 不再是 undefined ★ —— 插件恒写 draft.compaction，loop 侧 `draft.compaction!` 因此永不抛。
    // 无 settings 时产 no-op：未压缩、items 就是原 messages、各计数为 0。
    expect(draft.compaction).toEqual({
      items: original,
      compacted: false,
      withinBudget: true,
      estimatedTokensBefore: 0,
      estimatedTokensAfter: 0,
      effectiveBudgetTokens: 0,
      summarizedToolResults: 0,
      droppedItems: 0,
    })
  })
})

describe('compactionPlugin —— draft.tools / draft.llmTurn 省略时的兜底', () => {
  it('tools 省略按空数组算 reservedTokens；llmTurn 省略则 attrs.llm_turn 为 undefined', async () => {
    const settings: ModelSettings = { vendor: 'deepseek', model: 'x', max_tokens: 63_500 }
    const { ctx, traceEvent } = fakeCtx(settings)
    const bigContent = JSON.stringify({ data: 'x'.repeat(4000) })
    const messages = turnWithBigToolResult(bigContent)
    // 故意不设 tools / llmTurn（都是可选字段）。
    const draft: CompactionRequestDraft = { messages }

    await assemblePlugins([compactionPlugin]).transformContext?.(ctx, draft)

    expect(draft.compaction?.compacted).toBe(true)
    const [, attrs] = traceEvent.mock.calls[0] as [string, Record<string, unknown>]
    expect(attrs.llm_turn).toBeUndefined()
    // reserved_tk 按空 tools 数组计算（与显式传 tools:[] 的上一个用例应得到同一个 reserved_tk）。
    const reservedTokens =
      estimateTokensFromText(EMPTY_TOOLS_STATS) +
      (settings.max_tokens ?? DEFAULT_RESERVED_OUTPUT_TOKENS) +
      Math.ceil(Math.min(contextWindowTokens(settings.vendor, settings.model), COST_SOFT_CAP_TOKENS) * CONTEXT_SAFETY_MARGIN_RATIO)
    expect(attrs.reserved_tk).toBe(reservedTokens)
  })
})

// ---------------------------------------------------------------------------
// 压缩投影复用（CR1）
// ---------------------------------------------------------------------------
// 这一组盯的是「一次压缩摊到多轮」这件事本身，以及它的三道刹车：append-only 校验、预算复查、
// tool 协议兜底。任何一道被摘掉，长会话都会退回「每轮全额 cache-miss」的老样子（或更糟——
// 发出非法序列）。
//
// fixture 约定：max_tokens=100 让 reservedTokens 很小、effectiveBudget 很宽裕，靠一条 400KB 的
// 历史 tool 结果把 before 顶过预算 —— compacted:true 且 withinBudget:true，正是「会被缓存」
// 的唯一组合（与上面「压完仍超」那个用例刻意区分）。
const REUSABLE_SETTINGS: ModelSettings = { vendor: 'deepseek', model: 'x', max_tokens: 100 }
function bigToolContent(): string {
  return JSON.stringify({ data: 'x'.repeat(400_000) })
}
// tools/llmTurn 是 CompactionRequestDraft 的私有扩展字段，不在 LoopHooks 的 RequestDraft 上。
// 内联字面量传进 transformContext 会按 RequestDraft 做 excess property 检查而报 TS2353，
// 故统一经这个带标注的构造器建 draft。
function reuseDraft(messages: ModelItem[], llmTurn: number): CompactionRequestDraft {
  return { messages, tools: [], llmTurn }
}

describe('compactionPlugin —— 压缩投影复用', () => {
  it('append-only 的下一轮直接复用上轮投影：不重压、前缀逐条同引用、只发 reused 事件', async () => {
    const { ctx, traceEvent } = fakeCtx(REUSABLE_SETTINGS)
    const hooks = assemblePlugins([compactionPlugin])

    const base = turnWithBigToolResult(bigToolContent())
    const draft1 = reuseDraft(base, 1)
    await hooks.transformContext?.(ctx, draft1)
    expect(draft1.compaction?.compacted).toBe(true)
    const projection = draft1.messages

    // 第二轮：items 纯追加一条小 assistant（前 6 条与第一轮【同引用】）。
    const appended: ModelItem = { role: 'assistant', content: '第二轮答复' }
    const draft2: CompactionRequestDraft = { messages: [...base, appended], tools: [], llmTurn: 2 }
    await hooks.transformContext?.(ctx, draft2)

    // ★ 核心断言 ★：复用轮的前缀与上一轮投影【逐条同引用】—— 序列化出来必然逐字节相同，
    // provider 的前缀缓存才有可能整段命中。
    expect(draft2.messages.length).toBe(projection.length + 1)
    projection.forEach((item, index) => {
      expect(draft2.messages[index]).toBe(item)
    })
    expect(draft2.messages[draft2.messages.length - 1]).toBe(appended)

    // 复用轮不再执行压缩，因此不发 context_compacted；发的是独立的 reused 事件。
    expect(traceEvent).toHaveBeenCalledWith('llm.context_projection_reused', expect.objectContaining({
      llm_turn: 2,
      reuse_count: 1,
      appended_items: 1,
    }))
    expect(traceEvent).not.toHaveBeenCalledWith('llm.context_compacted', expect.objectContaining({ llm_turn: 2 }))
    // compacted 仍为真：投影确实是压缩产物，contextStats / llmSpan 的语义不能因复用而失真。
    expect(draft2.compaction?.compacted).toBe(true)
    expect(draft2.compaction?.withinBudget).toBe(true)
  })

  it('连续多轮复用：reuse_count 递增，全程只压过一次', async () => {
    const { ctx, traceEvent } = fakeCtx(REUSABLE_SETTINGS)
    const hooks = assemblePlugins([compactionPlugin])

    let messages = turnWithBigToolResult(bigToolContent())
    await hooks.transformContext?.(ctx, reuseDraft(messages, 1))
    for (let turn = 2; turn <= 5; turn += 1) {
      messages = [...messages, { role: 'assistant', content: `第 ${turn} 轮` }]
      await hooks.transformContext?.(ctx, reuseDraft(messages, turn))
    }

    const compactedCalls = traceEvent.mock.calls.filter(([name]) => name === 'llm.context_compacted')
    const reusedCalls = traceEvent.mock.calls.filter(([name]) => name === 'llm.context_projection_reused')
    expect(compactedCalls).toHaveLength(1) // 一次压缩摊了四轮
    expect(reusedCalls).toHaveLength(4)
    expect((reusedCalls[3][1] as Record<string, unknown>).reuse_count).toBe(4)
  })

  it('历史被改写（checkpoint 回滚 / revert）→ 前缀引用对不上，回落重压', async () => {
    const { ctx, traceEvent } = fakeCtx(REUSABLE_SETTINGS)
    const hooks = assemblePlugins([compactionPlugin])

    const base = turnWithBigToolResult(bigToolContent())
    await hooks.transformContext?.(ctx, reuseDraft(base, 1))

    // 同样的内容、全新的对象 —— 引用比较必须把它判成「历史变了」，否则回滚后的会话会拿到
    // 属于旧历史的投影。
    const rebuilt = turnWithBigToolResult(bigToolContent())
    const draft2 = reuseDraft(rebuilt, 2)
    await hooks.transformContext?.(ctx, draft2)

    expect(traceEvent).toHaveBeenCalledWith('llm.context_compacted', expect.objectContaining({ llm_turn: 2 }))
    expect(traceEvent).not.toHaveBeenCalledWith('llm.context_projection_reused', expect.anything())
  })

  it('历史变短（回退到更早的 checkpoint）→ 不复用', async () => {
    const { ctx, traceEvent } = fakeCtx(REUSABLE_SETTINGS)
    const hooks = assemblePlugins([compactionPlugin])

    const base = turnWithBigToolResult(bigToolContent())
    await hooks.transformContext?.(ctx, reuseDraft(base, 1))
    await hooks.transformContext?.(ctx, reuseDraft(base.slice(0, 4), 2))

    expect(traceEvent).not.toHaveBeenCalledWith('llm.context_projection_reused', expect.anything())
  })

  it('新增内容把预算撑爆 → 复用失效、重新压缩（不允许「为了命中率跳过压缩」）', async () => {
    const { ctx, traceEvent } = fakeCtx(REUSABLE_SETTINGS)
    const hooks = assemblePlugins([compactionPlugin])

    const base = turnWithBigToolResult(bigToolContent())
    await hooks.transformContext?.(ctx, reuseDraft(base, 1))

    // 第二轮新增一条巨大的 assistant 正文：旧投影 + 它必然超预算。
    const huge: ModelItem = { role: 'assistant', content: 'y'.repeat(400_000) }
    const draft2 = reuseDraft([...base, huge], 2)
    await hooks.transformContext?.(ctx, draft2)

    expect(traceEvent).not.toHaveBeenCalledWith('llm.context_projection_reused', expect.anything())
    expect(traceEvent).toHaveBeenCalledWith('llm.context_compacted', expect.objectContaining({ llm_turn: 2 }))
  })

  it('新增条目引用了投影里不存在的 tool_call_id → tool 协议兜底拒绝复用（CC3）', async () => {
    const { ctx, traceEvent } = fakeCtx(REUSABLE_SETTINGS)
    const hooks = assemblePlugins([compactionPlugin])

    const base = turnWithBigToolResult(bigToolContent())
    await hooks.transformContext?.(ctx, reuseDraft(base, 1))

    // 孤儿 tool：没有任何 assistant 声明过 'ghost'。若照常复用就会把非法序列发出去。
    const orphan: ModelItem = { role: 'tool', tool_call_id: 'ghost', content: '孤儿结果' }
    await hooks.transformContext?.(ctx, reuseDraft([...base, orphan], 2))

    expect(traceEvent).not.toHaveBeenCalledWith('llm.context_projection_reused', expect.anything())
    expect(traceEvent).toHaveBeenCalledWith('llm.context_compacted', expect.objectContaining({ llm_turn: 2 }))
  })

  // ── CR2：动态尾巴（plan 快照等）不参与压缩与前缀比较 ────────────────────────────
  // 这一组是账单驱动的回归：尾巴挂在 messages 末尾且每轮可能整条替换，位置又随历史增长后移。
  // 修复前它参与 entry.source 的引用比较，于是「历史追加一条」= 上一轮尾巴的下标被新条目占据
  // = 复用必然失败 = 每轮全额 cache-miss。实测两天里 dynamic_control_changed(173 次) +
  // compaction_projection_changed(214 次) 合计占 DeepSeek 账单的 71%。
  function tailDraft(messages: ModelItem[], llmTurn: number, dynamicTailCount: number): CompactionRequestDraft {
    return { messages, tools: [], llmTurn, dynamicTailCount }
  }

  it('尾巴逐轮替换 + 历史追加 → 仍复用投影，且尾巴按最新值接回（CR2 核心）', async () => {
    const { ctx, traceEvent } = fakeCtx(REUSABLE_SETTINGS)
    const hooks = assemblePlugins([compactionPlugin])

    const base = turnWithBigToolResult(bigToolContent())
    const tail1 = sysItem('<current_plan_snapshot>{"revision":1}</current_plan_snapshot>')
    const draft1 = tailDraft([...base, tail1], 1, 1)
    await hooks.transformContext?.(ctx, draft1)
    expect(draft1.compaction?.compacted).toBe(true)
    // 投影 = 事实历史压缩结果 + 尾巴；去掉尾巴那段才是下一轮要逐条同引用的前缀。
    const factProjection = draft1.messages.slice(0, -1)
    expect(draft1.messages[draft1.messages.length - 1]).toBe(tail1)

    // 第二轮：历史追加一条，尾巴换成新对象、内容也变了（plan revision 前进）。
    const appended: ModelItem = { role: 'assistant', content: '第二轮答复' }
    const tail2 = sysItem('<current_plan_snapshot>{"revision":2}</current_plan_snapshot>')
    const draft2 = tailDraft([...base, appended, tail2], 2, 1)
    await hooks.transformContext?.(ctx, draft2)

    // ★ 核心断言 ★：事实前缀逐条同引用 —— provider 能从头命中到尾巴之前。
    factProjection.forEach((item, index) => {
      expect(draft2.messages[index]).toBe(item)
    })
    expect(draft2.messages[factProjection.length]).toBe(appended)
    expect(draft2.messages[draft2.messages.length - 1]).toBe(tail2)
    expect(draft2.messages.length).toBe(factProjection.length + 2)

    expect(traceEvent).toHaveBeenCalledWith('llm.context_projection_reused', expect.objectContaining({
      llm_turn: 2,
      reuse_count: 1,
      appended_items: 1,
      dynamic_tail_items: 1,
    }))
    expect(traceEvent).not.toHaveBeenCalledWith('llm.context_compacted', expect.objectContaining({ llm_turn: 2 }))
  })

  it('对照：同样的输入不声明 dynamicTailCount 就会复用失败（证明修复确有作用）', async () => {
    const { ctx, traceEvent } = fakeCtx(REUSABLE_SETTINGS)
    const hooks = assemblePlugins([compactionPlugin])

    const base = turnWithBigToolResult(bigToolContent())
    const tail1 = sysItem('<current_plan_snapshot>{"revision":1}</current_plan_snapshot>')
    await hooks.transformContext?.(ctx, reuseDraft([...base, tail1], 1))

    const appended: ModelItem = { role: 'assistant', content: '第二轮答复' }
    const tail2 = sysItem('<current_plan_snapshot>{"revision":2}</current_plan_snapshot>')
    await hooks.transformContext?.(ctx, reuseDraft([...base, appended, tail2], 2))

    // 尾巴占着 entry.source 的最后一格，第二轮那一格换成了 appended → 引用比较失败 → 重压。
    expect(traceEvent).not.toHaveBeenCalledWith('llm.context_projection_reused', expect.anything())
    expect(traceEvent).toHaveBeenCalledWith('llm.context_compacted', expect.objectContaining({ llm_turn: 2 }))
  })

  it('尾巴的 token 计入预算：不会因为「压缩时看不见尾巴」而超发', async () => {
    const { ctx } = fakeCtx(REUSABLE_SETTINGS)
    const hooks = assemblePlugins([compactionPlugin])

    const base = turnWithBigToolResult(bigToolContent())
    const fat = sysItem('计'.repeat(20_000)) // 尾巴本身很占地方
    const draft = tailDraft([...base, fat], 1, 1)
    await hooks.transformContext?.(ctx, draft)

    // estimatedTokensAfter 描述整个请求（含尾巴），且必须仍在 effectiveBudget + 尾巴之内 ——
    // 即压缩没有因为看不见尾巴而多留了本该压掉的历史。
    const compaction = draft.compaction!
    expect(draft.messages[draft.messages.length - 1]).toBe(fat)
    expect(compaction.estimatedTokensAfter).toBeGreaterThan(estimateTokensFromText('计'.repeat(20_000)))
    expect(compaction.estimatedTokensAfter).toBeLessThanOrEqual(
      compaction.effectiveBudgetTokens + estimateTokensFromText('计'.repeat(20_000)) + 8,
    )
  })

  // ── CR4：投影缓存按会话 store 分桶，跨 run 存活 ──────────────────────────────
  it('跨 run 复用：第二个 run 重新装配插件，同一会话仍不重压（CR4）', async () => {
    const { ctx, traceEvent } = fakeCtx(REUSABLE_SETTINGS)
    const base = turnWithBigToolResult(bigToolContent())

    // run #1：assemblePlugins 建一份新闭包（旧实现里缓存就挂在这份闭包上）。
    const hooks1 = assemblePlugins([compactionPlugin])
    await hooks1.transformContext?.(ctx, reuseDraft(base, 1))
    expect(traceEvent).toHaveBeenCalledWith('llm.context_compacted', expect.objectContaining({ llm_turn: 1 }))

    // run #2：新的一次装配 = 新闭包，但会话 store 没变 —— 用户只是追加了一条消息。
    // 旧实现在这里必然重压（缓存随闭包丢失），实测就是 epochReason='initial' 那 105 次全量 miss。
    const hooks2 = assemblePlugins([compactionPlugin])
    const nextUserTurn: ModelItem = { role: 'user', content: '新 run 的第一条消息' }
    const draft2 = reuseDraft([...base, nextUserTurn], 1)
    await hooks2.transformContext?.(ctx, draft2)

    expect(traceEvent).toHaveBeenCalledWith('llm.context_projection_reused', expect.objectContaining({
      appended_items: 1,
    }))
    // 全程只压过一次：第二个 run 的首个请求整段命中。
    expect(traceEvent.mock.calls.filter(([name]) => name === 'llm.context_compacted')).toHaveLength(1)
    expect(draft2.messages[draft2.messages.length - 1]).toBe(nextUserTurn)
  })

  it('不同会话各自独立：A 的投影不会被 B 复用', async () => {
    const a = fakeCtx(REUSABLE_SETTINGS)
    const b = fakeCtx(REUSABLE_SETTINGS)
    const hooks = assemblePlugins([compactionPlugin])

    const base = turnWithBigToolResult(bigToolContent())
    await hooks.transformContext?.(a.ctx, reuseDraft(base, 1))
    expect(a.traceEvent).toHaveBeenCalledWith('llm.context_compacted', expect.anything())

    // B 是另一个会话 store：即使消息数组逐条同引用，也必须自己压一次，不能借 A 的投影。
    await hooks.transformContext?.(b.ctx, reuseDraft([...base, { role: 'assistant', content: 'B' }], 1))
    expect(b.traceEvent).not.toHaveBeenCalledWith('llm.context_projection_reused', expect.anything())
    expect(b.traceEvent).toHaveBeenCalledWith('llm.context_compacted', expect.anything())
  })

  it('压完仍超预算的投影不进缓存（异常态不该被一路延续）', async () => {
    // reservedTokens 吃光预算 → withinBudget:false，与「超预算压完仍超」用例同款配置。
    const settings: ModelSettings = { vendor: 'deepseek', model: 'x', max_tokens: 63_500 }
    const { ctx, traceEvent } = fakeCtx(settings)
    const hooks = assemblePlugins([compactionPlugin])

    const base = turnWithBigToolResult(bigToolContent())
    const draft1 = reuseDraft(base, 1)
    await hooks.transformContext?.(ctx, draft1)
    expect(draft1.compaction?.withinBudget).toBe(false)

    await hooks.transformContext?.(ctx, reuseDraft([...base, { role: 'assistant', content: '下一轮' }], 2))
    expect(traceEvent).not.toHaveBeenCalledWith('llm.context_projection_reused', expect.anything())
  })

  it('未触发压缩的轮次不写缓存（下轮照常走粗筛，不受影响）', async () => {
    const { ctx, traceEvent } = fakeCtx({ vendor: 'deepseek', model: 'x' })
    const hooks = assemblePlugins([compactionPlugin])

    const small: ModelItem[] = [sysItem('系统指令'), userItem('你好')]
    await hooks.transformContext?.(ctx, reuseDraft(small, 1))
    const draft2 = reuseDraft([...small, { role: 'assistant', content: '答复' }], 2)
    await hooks.transformContext?.(ctx, draft2)

    expect(traceEvent).not.toHaveBeenCalled()
    expect(draft2.compaction?.compacted).toBe(false)
  })

  it('不传 cache 时逐轮重压——与引入复用之前逐字一致（applyCompaction 本体默认行为）', async () => {
    const { ctx, traceEvent } = fakeCtx(REUSABLE_SETTINGS)
    const base = turnWithBigToolResult(bigToolContent())

    applyCompaction(ctx, reuseDraft(base, 1))
    applyCompaction(ctx, reuseDraft([...base, { role: 'assistant', content: 'x' }], 2))

    expect(traceEvent.mock.calls.filter(([name]) => name === 'llm.context_compacted')).toHaveLength(2)
    expect(traceEvent).not.toHaveBeenCalledWith('llm.context_projection_reused', expect.anything())
  })
})

// applyCompaction 本体的独立单测（不经 assemblePlugins/PluginApi 装配这层）——确保「插件注册」
// 与「压缩逻辑」两层各自都可单独验证，符合契约里「applyCompaction 可独立单测」的设计意图。
describe('applyCompaction（不经插件装配，直接调用本体）', () => {
  it('与经 compactionPlugin 装配后的行为一致', async () => {
    const settings: ModelSettings = { vendor: 'deepseek', model: 'x', max_tokens: 63_500 }
    const { ctx, traceEvent } = fakeCtx(settings)
    const bigContent = JSON.stringify({ data: 'x'.repeat(4000) })
    const draft: CompactionRequestDraft = { messages: turnWithBigToolResult(bigContent), tools: [], llmTurn: 3 }

    applyCompaction(ctx, draft)

    expect(draft.compaction?.compacted).toBe(true)
    expect(traceEvent).toHaveBeenCalledWith('llm.context_compacted', expect.objectContaining({ llm_turn: 3 }))
  })
})
