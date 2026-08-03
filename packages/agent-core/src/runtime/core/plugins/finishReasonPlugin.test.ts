// finishReasonPlugin 隔离测——不经 modelRun，直接给假 CoreCtx + TurnEndEvent 验证 onTurnEnd 槽。
// ---------------------------------------------------------------------------
// 覆盖：
//   · 异常三态各一（Case B，无流式条目）：追加正确的「系统标注」assistant 条目 + 返回正确 decision。
//     - length + 有正文：条目 = 正文 + ITEM_NOTICE（标注只追加、不顶掉正文）。
//     - content_filter / insufficient + 空正文：条目 = STANDALONE_NOTICE（单独成条，主语「本轮回复」、
//       不以换行起头、不含「以上回复」）。
//   · 不干预（返回 void、不动条目）：正常 stop / tool_calls / null，以及【length + 有 tool_calls】
//     这条可恢复截断（重点「别动那条」——留给坏 JSON 闸门）。
//   · Case A（流式已建条目 hasStreamedItem:true）：不补条目（标注由 loop 的 finalize 追加），但仍返回决策。
//   · 非 current（会话未登记，ghost/stale）：不补条目，但仍返回决策（与旧代码一致：appendItem 被守卫
//     跳过，但 run 收尾仍照走）。
//   · 经 assemblePlugins 装配后的 fan-out 接线：异常 → 复合 onTurnEnd 返回 decision；正常 → undefined。
//   · isAbnormalFinishReason 类型守卫真值表。
//   · 三份文案常量【逐字】断言（防止有人手滑改文案）。
// 变异自检：把 applyFinishReason 返回的 decision.stop 去掉（或整个 decision 去掉），
//   「decision toEqual {stop:true,...}」与「装配后复合 onTurnEnd 返回 decision」两处会立刻变红。

import { describe, expect, it, vi } from 'vitest'
import { createStore, type Store } from '@einfach/core'

import type { AssistantItem, ModelResponseMessage } from '@web-agent/ai'
import { sessionsAtom } from '../../../state/rootStore'
import { itemsAtom, runAtom } from '../../../state/sessionAtoms'
import type { SessionMeta } from '../../../state/core.type'
import { makeCoreCtx, type CoreCtx } from '../coreCtx'
import { assemblePlugins } from '../pluginApi'
import type { TurnEndDecision, TurnEndEvent } from '../loopHooks'
import {
  applyFinishReason,
  finishReasonPlugin,
  isAbnormalFinishReason,
  FINISH_REASON_ERRORS,
  FINISH_REASON_ITEM_NOTICES,
  FINISH_REASON_STANDALONE_NOTICES,
} from './finishReasonPlugin'

// 假 CoreCtx：current=true 时登记会话 s1 + 把 store 的 runAtom 置成 runId r1，令 ctx.isCurrent()
// 为真（isCurrentRun 双查：会话在 root.sessionsAtom + store.runAtom.runId === runId）。
// current=false 时不登记会话 → isCurrent() 返回 false（模拟会话已被 drop / run 被顶掉）。
function makeCtx(opts: { current?: boolean } = {}): { ctx: CoreCtx; store: Store } {
  const current = opts.current ?? true
  const root = createStore()
  const store = createStore()
  if (current) {
    root.setter(sessionsAtom, { s1: { id: 's1' } as unknown as SessionMeta })
    store.setter(runAtom, { runId: 'r1', status: 'running' })
  }
  const ctx = makeCoreCtx({
    sessionId: 's1',
    runId: 'r1',
    signal: new AbortController().signal,
    store,
    root,
    traceEvent: vi.fn(),
  })
  return { ctx, store }
}

// 构造一个完整 TurnEndEvent（toolCalls 默认空数组）。
function turnEnd(
  finishReason: string | null,
  extra: Partial<TurnEndEvent> = {},
): TurnEndEvent {
  return {
    finishReason,
    toolCalls: extra.toolCalls ?? [],
    assistantHasContent: extra.assistantHasContent ?? false,
    msg: extra.msg,
    hasStreamedItem: extra.hasStreamedItem ?? false,
  }
}

function respMsg(content: string | null, reasoning?: string): ModelResponseMessage {
  return { role: 'assistant', content, reasoning_content: reasoning ?? null }
}

// 取 store 里唯一那条 assistant 条目的 item（补条目场景下就一条）。
function onlyAssistant(store: Store): AssistantItem {
  const items = store.getter(itemsAtom)
  expect(items).toHaveLength(1)
  const item = items[0].item
  if (item.role !== 'assistant') throw new Error('意外的条目形状')
  return item
}

describe('finishReasonPlugin —— 异常三态各一（Case B：无流式条目，补条目 + 决策）', () => {
  it('length 且有正文：条目 = 正文 + ITEM_NOTICE（标注追加不顶正文），返回 error 决策', () => {
    const { ctx, store } = makeCtx()
    const decision = applyFinishReason(ctx, turnEnd('length', { msg: respMsg('半截答案') }))

    const item = onlyAssistant(store)
    // 逐字：正文 + ITEM_NOTICE，且以原正文起头（标注只追加）。
    expect(item.content).toBe(`半截答案${FINISH_REASON_ITEM_NOTICES.length}`)
    expect(item.content?.startsWith('半截答案')).toBe(true)
    // 补条目绝不带 tool_calls（本轮要终止、不执行工具，落 tool_calls 就成孤儿）。
    expect('tool_calls' in item).toBe(false)
    // 决策：带状态终止 run，reason = 对应 FINISH_REASON_ERRORS 文案（逐字）。
    expect(decision).toEqual<TurnEndDecision>({
      stop: true,
      runStatus: 'error',
      reason: FINISH_REASON_ERRORS.length,
      traceEventName: 'agent.finish_abnormal',
    })
  })

  it('content_filter 且空正文：单独落「仅含标注」条目（主语「本轮回复」、不以换行起头）', () => {
    const { ctx, store } = makeCtx()
    const decision = applyFinishReason(ctx, turnEnd('content_filter', { msg: respMsg(null) }))

    const item = onlyAssistant(store)
    // 逐字：STANDALONE_NOTICE（不是拼接正文的 ITEM_NOTICE）。
    expect(item.content).toBe(FINISH_REASON_STANDALONE_NOTICES.content_filter)
    // 独立条目不从空行起头；主语是「本轮回复」而非会指到用户身上的「以上回复」。
    expect(item.content?.startsWith('\n')).toBe(false)
    expect(item.content).toContain('本轮回复')
    expect(item.content).not.toContain('以上回复')
    expect(decision).toEqual<TurnEndDecision>({
      stop: true,
      runStatus: 'error',
      reason: FINISH_REASON_ERRORS.content_filter,
      traceEventName: 'agent.finish_abnormal',
    })
  })

  it('insufficient_system_resource 且空正文：单独落「仅含标注」条目 + 稍后重试决策', () => {
    const { ctx, store } = makeCtx()
    const decision = applyFinishReason(
      ctx,
      turnEnd('insufficient_system_resource', { msg: respMsg(null) }),
    )

    const item = onlyAssistant(store)
    expect(item.content).toBe(FINISH_REASON_STANDALONE_NOTICES.insufficient_system_resource)
    expect(decision).toEqual<TurnEndDecision>({
      stop: true,
      runStatus: 'error',
      reason: FINISH_REASON_ERRORS.insufficient_system_resource,
      traceEventName: 'agent.finish_abnormal',
    })
    // reason 逐字点名「稍后重试」（与 modelRun.test 的 fr4 用例同锚点）。
    expect(decision?.reason).toContain('稍后重试')
  })

  it('length 且空正文：单独落「仅含标注」条目（不误报「空回复」）', () => {
    const { ctx, store } = makeCtx()
    const decision = applyFinishReason(ctx, turnEnd('length', { msg: respMsg('') }))

    // '' 经 trim 为空 → assistantHasContent 为 false → 走 STANDALONE。
    expect(onlyAssistant(store).content).toBe(FINISH_REASON_STANDALONE_NOTICES.length)
    expect(decision?.reason).toContain('finish_reason=length')
    expect(decision?.reason).not.toContain('空回复')
  })

  it('有正文时把 msg.reasoning_content 一并带进补出的条目（与旧 assistantItemFromMessage 同构）', () => {
    const { ctx, store } = makeCtx()
    applyFinishReason(ctx, turnEnd('length', { msg: respMsg('半截', '思维链') }))
    expect(onlyAssistant(store).reasoning_content).toBe('思维链')
  })
})

describe('finishReasonPlugin —— 不干预（返回 void、不动条目）', () => {
  it('正常 stop：返回 undefined，不追加任何条目', () => {
    const { ctx, store } = makeCtx()
    const decision = applyFinishReason(ctx, turnEnd('stop', { msg: respMsg('正常答复') }))
    expect(decision).toBeUndefined()
    expect(store.getter(itemsAtom)).toHaveLength(0)
  })

  it('tool_calls：返回 undefined，不动条目', () => {
    const { ctx, store } = makeCtx()
    const decision = applyFinishReason(ctx, turnEnd('tool_calls', { toolCalls: [{}] }))
    expect(decision).toBeUndefined()
    expect(store.getter(itemsAtom)).toHaveLength(0)
  })

  it('finishReason 为 null：返回 undefined，不动条目', () => {
    const { ctx, store } = makeCtx()
    expect(applyFinishReason(ctx, turnEnd(null))).toBeUndefined()
    expect(store.getter(itemsAtom)).toHaveLength(0)
  })

  it('length + 有 tool_calls（可恢复截断，重点「别动那条」）：返回 undefined，不动条目', () => {
    const { ctx, store } = makeCtx()
    // 半截 arguments 的典型场景：不在此终止，留给坏 JSON 闸门。
    const decision = applyFinishReason(ctx, turnEnd('length', { toolCalls: [{}], msg: respMsg('半截') }))
    expect(decision).toBeUndefined()
    expect(store.getter(itemsAtom)).toHaveLength(0)
  })

  it('content_filter + 有 tool_calls：仍终止（与旧 else-if 分支逐字等价，不被 tool_calls 豁免）', () => {
    // 旧代码第一个 if 只拦 length+tool_calls，故 content_filter 无论 toolCalls 多少都落进终止分支。
    const { ctx, store } = makeCtx()
    const decision = applyFinishReason(ctx, turnEnd('content_filter', { toolCalls: [{}], msg: respMsg(null) }))
    expect(decision?.stop).toBe(true)
    expect(store.getter(itemsAtom)).toHaveLength(1)
  })
})

describe('finishReasonPlugin —— Case A（流式已建条目）不补条目但仍返回决策', () => {
  it('hasStreamedItem:true：不追加条目（标注由 loop finalize 追加），仍返回 error 决策', () => {
    const { ctx, store } = makeCtx()
    const decision = applyFinishReason(
      ctx,
      turnEnd('length', { msg: respMsg('半截答案'), hasStreamedItem: true }),
    )
    // 插件不补条目（避免与 loop 的 finalize 重复）。
    expect(store.getter(itemsAtom)).toHaveLength(0)
    // 但决策照常返回——run 收尾（commit/patchRun/退出）由 loop 据此执行。
    expect(decision).toEqual<TurnEndDecision>({
      stop: true,
      runStatus: 'error',
      reason: FINISH_REASON_ERRORS.length,
      traceEventName: 'agent.finish_abnormal',
    })
  })
})

describe('finishReasonPlugin —— 非 current（ghost/stale）不补条目但仍返回决策', () => {
  it('会话未登记：ctx.isCurrent() 假 → 不追加条目，但仍返回决策', () => {
    const { ctx, store } = makeCtx({ current: false })
    const decision = applyFinishReason(ctx, turnEnd('content_filter', { msg: respMsg(null) }))
    expect(store.getter(itemsAtom)).toHaveLength(0)
    expect(decision?.stop).toBe(true)
    expect(decision?.reason).toBe(FINISH_REASON_ERRORS.content_filter)
  })
})

describe('finishReasonPlugin —— 经 assemblePlugins 装配（onTurnEnd fan-out 接线）', () => {
  it('异常态：复合 onTurnEnd 把 stop 决策原样带出（变异自检锚点：去掉 stop 即变红）', async () => {
    const { ctx } = makeCtx()
    const hooks = assemblePlugins([finishReasonPlugin])
    const decision = await hooks.onTurnEnd?.(ctx, turnEnd('content_filter', { msg: respMsg(null) }))
    // assemblePlugins 的合并语义：第一个返回 {stop:true} 的胜；若插件不返回 stop，这里会变成 undefined。
    expect(decision).toEqual<TurnEndDecision>({
      stop: true,
      runStatus: 'error',
      reason: FINISH_REASON_ERRORS.content_filter,
      traceEventName: 'agent.finish_abnormal',
    })
  })

  it('正常态：复合 onTurnEnd 返回 undefined（不终止，loop 继续）', async () => {
    const { ctx, store } = makeCtx()
    const hooks = assemblePlugins([finishReasonPlugin])
    const decision = await hooks.onTurnEnd?.(ctx, turnEnd('stop', { msg: respMsg('正常答复') }))
    expect(decision).toBeUndefined()
    expect(store.getter(itemsAtom)).toHaveLength(0)
  })
})

describe('isAbnormalFinishReason 类型守卫真值表', () => {
  it('三态为真，其余为假', () => {
    expect(isAbnormalFinishReason('length')).toBe(true)
    expect(isAbnormalFinishReason('content_filter')).toBe(true)
    expect(isAbnormalFinishReason('insufficient_system_resource')).toBe(true)
    expect(isAbnormalFinishReason('stop')).toBe(false)
    expect(isAbnormalFinishReason('tool_calls')).toBe(false)
    expect(isAbnormalFinishReason('')).toBe(false)
    expect(isAbnormalFinishReason(null)).toBe(false)
  })
})

// 文案逐字断言 —— 与 modelRun.ts 搬迁前一字不差。任何手滑改文案（含标点/空格/换行/emoji）在此变红。
describe('finish_reason 三份文案常量逐字不变', () => {
  it('FINISH_REASON_ERRORS 逐字', () => {
    expect(FINISH_REASON_ERRORS).toEqual({
      length: '模型输出触顶被截断（finish_reason=length），本轮回复不完整；请调高 max_tokens 或让模型分段输出',
      content_filter: '模型输出被内容安全策略拦截（finish_reason=content_filter）',
      insufficient_system_resource: '模型服务容量不足（finish_reason=insufficient_system_resource），请稍后重试',
    })
  })

  it('FINISH_REASON_ITEM_NOTICES 逐字（含前导 \\n\\n 与 length 的两段拼接）', () => {
    expect(FINISH_REASON_ITEM_NOTICES).toEqual({
      length:
        '\n\n> ⚠️ 【系统标注】以上回复因触达输出上限被截断（finish_reason=length），内容不完整。' +
        '其中的推理很可能只进行到一半，不要把它当作已成立的结论直接沿用。',
      content_filter:
        '\n\n> ⚠️ 【系统标注】以上回复被内容安全策略拦截（finish_reason=content_filter），内容不完整。',
      insufficient_system_resource:
        '\n\n> ⚠️ 【系统标注】以上回复因模型服务容量不足而中断（finish_reason=insufficient_system_resource），内容不完整。',
    })
  })

  it('FINISH_REASON_STANDALONE_NOTICES 逐字（无前导换行、主语「本轮回复」）', () => {
    expect(FINISH_REASON_STANDALONE_NOTICES).toEqual({
      length:
        '> ⚠️ 【系统标注】本轮回复因触达输出上限被截断（finish_reason=length），未产生任何内容。',
      content_filter:
        '> ⚠️ 【系统标注】本轮回复被内容安全策略拦截（finish_reason=content_filter），未产生任何内容。',
      insufficient_system_resource:
        '> ⚠️ 【系统标注】本轮回复因模型服务容量不足而中断（finish_reason=insufficient_system_resource），未产生任何内容。',
    })
  })
})
