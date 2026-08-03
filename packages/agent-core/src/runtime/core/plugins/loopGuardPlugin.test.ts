// loopGuardPlugin 隔离测——不经 modelRun，用假 CoreCtx + 手搓 TurnEndEvent 直接验证 onTurnEnd 槽
// 的跨轮循环检测：签名规范化、达阈值收尾决策、未达/异号返回 void、按 run 隔离的闭包计数。
// ---------------------------------------------------------------------------
// 覆盖（对齐任务补测要求）：
//   · 签名规范化：键序无关 / 嵌套递归 / 数组保序 / 基元 / JSON.stringify 抛错时降级 String（永不抛）。
//   · 同签名重复到阈值(3) → 第 3 次返回 stop 决策 + 全套 trace attrs（toolName/callId/argsPreview/
//     repeated_count/consecutive_tool_turns/threshold/error）逐字对齐旧内联；前两次返回 undefined。
//   · 不同签名 / 未达阈值 → 始终 undefined（每个签名各自计数，谁都到不了 3）。
//   · 同轮去重（seenThisTurn）：一轮里同签名出现多次只累加 1（单轮 3 个相同调用【不】判成环）。
//   · 三种「非纯工具轮」清零：assistantHasContent / finishReason≠'tool_calls' / 空 toolCalls
//     都会清空签名 Map + consecutiveToolOnlyTurns。
//   · consecutive_tool_turns 与 repeated_count 是两个独立计数器（连续纯工具轮数 ≠ 某签名重复数）。
//   · 坏 JSON 用原始串参与签名：反复重发同一段坏 JSON 照样命中；不同坏 JSON 不误并。
//   · per-run 隔离：两个检测器实例 / 两次 assemblePlugins 装配的复合槽，计数互不串味。
//   · 经 assemblePlugins 复合 onTurnEnd 与直调检测器行为一致。
//
// 变异自检（已手动验证过——把插件改坏确认这些断言会红，再改回）：
//   · `repeatedCount >= LOOP_DETECTION_THRESHOLD` 改成 `>` → 「第 3 次命中」相关断言变红（要等到第 4 次）。
//   · 删掉 else 分支的 `repeatedToolSignatures.clear()` → 「清零后重新计数」相关断言变红。
//   · 删掉 `seenThisTurn` 去重（continue 那两行）→ 「单轮 3 个相同调用不判成环」变红。
//   · createLoopGuardDetector 里的两份状态提到模块级（伪单例）→ per-run 隔离断言变红。

import { describe, expect, it } from 'vitest'
import { createStore } from '@einfach/core'

import type { ModelToolCall } from '@web-agent/ai'
import { truncatePayload } from '../../../observability/redact'
import { makeCoreCtx, type CoreCtx } from '../coreCtx'
import type { TurnEndDecision, TurnEndEvent, TurnEndStopDecision } from '../loopHooks'
import { assemblePlugins } from '../pluginApi'
import {
  createLoopGuardDetector,
  loopGuardPlugin,
  LOOP_DETECTED_ERROR,
  LOOP_DETECTION_THRESHOLD,
  normalizedArgsSignature,
  toolCallSignature,
} from './loopGuardPlugin'

// 检测器用不到 ctx（只吃事件里的瞬时数据）——给一个最小可信的真 CoreCtx，形状对齐即可。
function fakeCtx(): CoreCtx {
  return makeCoreCtx({
    sessionId: 's1',
    runId: 'r1',
    signal: new AbortController().signal,
    store: createStore(),
    root: createStore(),
    traceEvent: () => {},
  })
}
const ctx = fakeCtx()

// arguments 是线协议里的 JSON 字符串（可传合法 JSON、坏 JSON、空串）。
function toolCall(name: string, argumentsJson: string, id = 'c1'): ModelToolCall {
  return { id, type: 'function', function: { name, arguments: argumentsJson } }
}

// 默认造一个「纯工具轮」事件：finishReason='tool_calls' + 无正文。over 覆盖成清零态用。
function turnEnd(
  toolCalls: ModelToolCall[],
  over: Partial<TurnEndEvent> = {},
): TurnEndEvent {
  return {
    finishReason: 'tool_calls',
    toolCalls,
    assistantHasContent: false,
    msg: undefined,
    hasStreamedItem: false,
    ...over,
  }
}

function hit(decision: void | TurnEndDecision | undefined): TurnEndStopDecision {
  if (!decision?.stop) throw new Error('预期循环检测返回 stop 决策')
  return decision
}

describe('签名规范化（normalizedArgsSignature / toolCallSignature）', () => {
  it('对象键序无关：不同键序 → 同一签名', () => {
    expect(normalizedArgsSignature({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
    expect(normalizedArgsSignature({ a: 2, b: 1 })).toBe(normalizedArgsSignature({ b: 1, a: 2 }))
  })

  it('嵌套对象递归规范化键序', () => {
    expect(normalizedArgsSignature({ x: { b: 1, a: 2 }, y: 3 })).toBe('{"x":{"a":2,"b":1},"y":3}')
    expect(normalizedArgsSignature({ y: 3, x: { a: 2, b: 1 } })).toBe(
      normalizedArgsSignature({ x: { b: 1, a: 2 }, y: 3 }),
    )
  })

  it('数组保持原序（顺序是语义，不排序）', () => {
    expect(normalizedArgsSignature([1, 2])).toBe('[1,2]')
    expect(normalizedArgsSignature([2, 1])).toBe('[2,1]')
    expect(normalizedArgsSignature([1, 2])).not.toBe(normalizedArgsSignature([2, 1]))
    // 数组内的对象仍按键序规范化。
    expect(normalizedArgsSignature([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]')
  })

  it('基元原样序列化', () => {
    expect(normalizedArgsSignature('x')).toBe('"x"')
    expect(normalizedArgsSignature(5)).toBe('5')
    expect(normalizedArgsSignature(null)).toBe('null')
    expect(normalizedArgsSignature(true)).toBe('true')
    expect(normalizedArgsSignature({})).toBe('{}')
  })

  it('JSON.stringify 抛错时降级 String（永不抛）', () => {
    // BigInt 无法被 JSON.stringify → 走 catch 分支返回 String(10n)='10'（对齐旧代码的 try/catch）。
    expect(normalizedArgsSignature(10n)).toBe('10')
  })

  it('toolCallSignature = `工具名:参数签名`', () => {
    expect(toolCallSignature('foo', { a: 1 })).toBe('foo:{"a":1}')
    expect(toolCallSignature('foo', {})).toBe('foo:{}')
    // 键序无关一路透到 toolCallSignature。
    expect(toolCallSignature('foo', { b: 2, a: 1 })).toBe(toolCallSignature('foo', { a: 1, b: 2 }))
  })

  it('导出常量逐字对齐旧值', () => {
    expect(LOOP_DETECTION_THRESHOLD).toBe(3)
    expect(LOOP_DETECTED_ERROR).toBe('检测到重复工具调用循环')
  })
})

describe('createLoopGuardDetector —— 跨轮累计 + 达阈值判定', () => {
  it('同签名重复到阈值(3)：第 3 次返回 stop 决策 + 全套 trace attrs，前两次 undefined', () => {
    const detect = createLoopGuardDetector()
    const call = toolCall('request_tool_schema', '{"reason":"loop"}', 'call-1')

    expect(detect(ctx, turnEnd([call]))).toBeUndefined() // 轮1：count 1
    expect(detect(ctx, turnEnd([call]))).toBeUndefined() // 轮2：count 2

    const decision = hit(detect(ctx, turnEnd([call]))) // 轮3：count 3 → 命中
    expect(decision).toBeDefined()
    expect(decision.stop).toBe(true)
    expect(decision.runStatus).toBe('error')
    expect(decision.reason).toBe('检测到重复工具调用循环')
    expect(decision.traceEventName).toBe('agent.loop_detected')
    expect(decision.traceAttrs).toEqual({
      loop_detected: true,
      toolName: 'request_tool_schema',
      callId: 'call-1',
      argsPreview: truncatePayload({ reason: 'loop' }, 500),
      repeated_count: 3,
      consecutive_tool_turns: 3,
      threshold: 3,
      error: '检测到重复工具调用循环',
    })
  })

  it('不同签名每轮换一个：谁都到不了阈值 → 恒 undefined', () => {
    const detect = createLoopGuardDetector()
    for (let i = 0; i < 5; i++) {
      expect(detect(ctx, turnEnd([toolCall('t', `{"i":${i}}`)]))).toBeUndefined()
    }
  })

  it('同轮去重：单轮出现 3 个相同调用只累加 1，不判成环', () => {
    const detect = createLoopGuardDetector()
    const dup = [
      toolCall('t', '{"a":1}', 'a'),
      toolCall('t', '{"a":1}', 'b'),
      toolCall('t', '{"a":1}', 'c'),
    ]
    // 单轮 3 个相同签名 → seenThisTurn 去重后只 +1 → 不命中。
    expect(detect(ctx, turnEnd(dup))).toBeUndefined()
    // 还需再来两轮才到 3。
    expect(detect(ctx, turnEnd([toolCall('t', '{"a":1}')]))).toBeUndefined() // count 2
    expect(detect(ctx, turnEnd([toolCall('t', '{"a":1}')]))).toBeDefined() // count 3 → 命中
  })

  it('assistantHasContent=true → 非纯工具轮，清零签名计数', () => {
    const detect = createLoopGuardDetector()
    const call = toolCall('t', '{"a":1}')
    expect(detect(ctx, turnEnd([call]))).toBeUndefined() // count 1
    expect(detect(ctx, turnEnd([call]))).toBeUndefined() // count 2
    // 有正文的一轮 → isToolOnlyTurn=false → clear()。
    expect(detect(ctx, turnEnd([call], { assistantHasContent: true }))).toBeUndefined()
    // 清零后重新计数：再来两轮仍不够（此前的 2 已被抹掉）。
    expect(detect(ctx, turnEnd([call]))).toBeUndefined() // count 1（重新起）
    expect(detect(ctx, turnEnd([call]))).toBeUndefined() // count 2
    expect(detect(ctx, turnEnd([call]))).toBeDefined() // count 3 → 命中
  })

  it("finishReason≠'tool_calls' → 非纯工具轮，清零", () => {
    const detect = createLoopGuardDetector()
    const call = toolCall('t', '{"a":1}')
    expect(detect(ctx, turnEnd([call]))).toBeUndefined() // count 1
    expect(detect(ctx, turnEnd([call]))).toBeUndefined() // count 2
    expect(detect(ctx, turnEnd([call], { finishReason: 'stop' }))).toBeUndefined() // 清零
    expect(detect(ctx, turnEnd([call]))).toBeUndefined() // count 1
    expect(detect(ctx, turnEnd([call]))).toBeUndefined() // count 2
    expect(detect(ctx, turnEnd([call]))).toBeDefined() // count 3
  })

  it('空 toolCalls（即便 finishReason=tool_calls）→ 非纯工具轮，清零', () => {
    const detect = createLoopGuardDetector()
    const call = toolCall('t', '{"a":1}')
    expect(detect(ctx, turnEnd([call]))).toBeUndefined() // count 1
    expect(detect(ctx, turnEnd([call]))).toBeUndefined() // count 2
    expect(detect(ctx, turnEnd([]))).toBeUndefined() // toolCalls.length===0 → 清零
    expect(detect(ctx, turnEnd([call]))).toBeUndefined() // count 1
    expect(detect(ctx, turnEnd([call]))).toBeUndefined() // count 2
    expect(detect(ctx, turnEnd([call]))).toBeDefined() // count 3
  })

  it('consecutive_tool_turns 与 repeated_count 是两个独立计数器', () => {
    const detect = createLoopGuardDetector()
    // 轮1..2 用签名 A、B 各一次（都不重复），轮3..4 命中 A：连续纯工具轮 = 4，但 A 的重复数 = 3。
    detect(ctx, turnEnd([toolCall('t', '{"k":"A"}')])) // 连续1，A=1
    detect(ctx, turnEnd([toolCall('t', '{"k":"B"}')])) // 连续2，B=1
    detect(ctx, turnEnd([toolCall('t', '{"k":"A"}')])) // 连续3，A=2
    const decision = hit(detect(ctx, turnEnd([toolCall('t', '{"k":"A"}')]))) // 连续4，A=3 → 命中
    expect(decision.traceAttrs?.repeated_count).toBe(3)
    expect(decision.traceAttrs?.consecutive_tool_turns).toBe(4)
  })

  it('命中只记「第一个」达阈值的 tool_call（args/callId 取它）', () => {
    const detect = createLoopGuardDetector()
    // 先让签名 X、Y 各累计到 2。
    detect(ctx, turnEnd([toolCall('t', '{"s":"X"}', 'x1'), toolCall('t', '{"s":"Y"}', 'y1')]))
    detect(ctx, turnEnd([toolCall('t', '{"s":"X"}', 'x2'), toolCall('t', '{"s":"Y"}', 'y2')]))
    // 这一轮 X、Y 都到 3，但只记数组里靠前的 X。
    const decision = hit(detect(
      ctx,
      turnEnd([toolCall('t', '{"s":"X"}', 'x3'), toolCall('t', '{"s":"Y"}', 'y3')]),
    ))
    expect(decision.traceAttrs?.callId).toBe('x3')
    expect(decision.traceAttrs?.argsPreview).toBe(truncatePayload({ s: 'X' }, 500))
  })
})

describe('坏 JSON 参数的签名降级', () => {
  it('反复重发同一段坏 JSON → 用原始串签名，照样命中（args 降级为 {}）', () => {
    const detect = createLoopGuardDetector()
    const bad = toolCall('skill_search', '{"query":', 'loop1')
    expect(detect(ctx, turnEnd([bad]))).toBeUndefined()
    expect(detect(ctx, turnEnd([bad]))).toBeUndefined()
    const decision = hit(detect(ctx, turnEnd([bad])))
    expect(decision.stop).toBe(true)
    expect(decision.reason).toBe('检测到重复工具调用循环')
    expect(decision.traceAttrs?.toolName).toBe('skill_search')
    // 坏 JSON 的 parsed.args 是 {} → argsPreview 是 '{}'。
    expect(decision.traceAttrs?.argsPreview).toBe(truncatePayload({}, 500))
  })

  it('不同坏 JSON 不被误并成一条签名', () => {
    const detect = createLoopGuardDetector()
    expect(detect(ctx, turnEnd([toolCall('t', '{"a":')]))).toBeUndefined() // raw:{"a":  → 1
    expect(detect(ctx, turnEnd([toolCall('t', '{"b":')]))).toBeUndefined() // raw:{"b":  → 1
    expect(detect(ctx, turnEnd([toolCall('t', '{"a":')]))).toBeUndefined() // raw:{"a":  → 2
    expect(detect(ctx, turnEnd([toolCall('t', '{"b":')]))).toBeUndefined() // raw:{"b":  → 2
    // 谁都没到 3。
  })
})

describe('per-run 隔离（闭包计数）', () => {
  it('两个检测器实例计数互不串味', () => {
    const d1 = createLoopGuardDetector()
    const d2 = createLoopGuardDetector()
    const call = toolCall('t', '{}')

    d1(ctx, turnEnd([call])) // d1: 1
    d1(ctx, turnEnd([call])) // d1: 2
    expect(d2(ctx, turnEnd([call]))).toBeUndefined() // d2: 1（没继承 d1 的 2）
    expect(d1(ctx, turnEnd([call]))).toBeDefined() // d1: 3 → 命中
    expect(d2(ctx, turnEnd([call]))).toBeUndefined() // d2: 2（仍没命中）
  })
})

describe('loopGuardPlugin —— 经 assemblePlugins 复合 onTurnEnd', () => {
  it('装配后复合 onTurnEnd 与直调检测器行为一致（第 3 次命中）', async () => {
    const hooks = assemblePlugins([loopGuardPlugin])
    const call = toolCall('t', '{"x":1}')

    expect(await hooks.onTurnEnd?.(ctx, turnEnd([call]))).toBeUndefined()
    expect(await hooks.onTurnEnd?.(ctx, turnEnd([call]))).toBeUndefined()
    const decision = hit(await hooks.onTurnEnd?.(ctx, turnEnd([call])))
    expect(decision.stop).toBe(true)
    expect(decision.traceEventName).toBe('agent.loop_detected')
    expect(decision.traceAttrs?.repeated_count).toBe(3)
  })

  it('每次 assemblePlugins 是全新计数（per-run 隔离到复合槽层面）', async () => {
    const a = assemblePlugins([loopGuardPlugin])
    const b = assemblePlugins([loopGuardPlugin])
    const call = toolCall('t', '{}')

    await a.onTurnEnd?.(ctx, turnEnd([call])) // a: 1
    await a.onTurnEnd?.(ctx, turnEnd([call])) // a: 2
    expect(await b.onTurnEnd?.(ctx, turnEnd([call]))).toBeUndefined() // b: 1
    const aHit = hit(await a.onTurnEnd?.(ctx, turnEnd([call])))
    expect(aHit.stop).toBe(true) // a: 3 → 命中
    expect(await b.onTurnEnd?.(ctx, turnEnd([call]))).toBeUndefined() // b: 2（未受 a 影响）
  })
})
