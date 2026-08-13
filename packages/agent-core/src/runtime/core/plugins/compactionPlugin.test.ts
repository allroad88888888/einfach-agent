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
  type CompactionRequestDraft,
} from './compactionPlugin'
import {
  CONTEXT_SAFETY_MARGIN_RATIO,
  COST_SOFT_CAP_TOKENS,
  DEFAULT_RESERVED_OUTPUT_TOKENS,
  contextInputBudgetTokens,
} from '../../contextBudget'

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
