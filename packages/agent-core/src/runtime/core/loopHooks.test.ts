import { describe, expect, it } from 'vitest'

import type { ModelItem, UserItem } from '@web-agent/ai'
import type { CoreCtx } from './coreCtx'
import type {
  AfterToolCallEvent,
  BeforeToolCallEvent,
  BeforeToolCallResult,
  LoopHooks,
  RequestDraft,
  TurnEndDecision,
  TurnEndEvent,
} from './loopHooks'

// loopHooks 只导出类型 —— 这里用「手写一个符合契约的 LoopHooks 实现并调用它」来同时锁住
// 编译期形状（TS 结构校验）与运行期行为，防止后续 Stage 无声改动槽签名。

function user(content: string): UserItem {
  return { role: 'user', content }
}

const fakeCtx = { sessionId: 's', runId: 'r' } as unknown as CoreCtx

describe('LoopHooks / RequestDraft 契约形状', () => {
  it('RequestDraft.messages 承载 ModelItem[]；transformContext 就地改投影、不返回新对象', async () => {
    const draft: RequestDraft = { messages: [user('a')] }
    const hooks: LoopHooks = {
      transformContext(_ctx, d) {
        d.messages = [...d.messages, user('b')]
      },
    }

    await hooks.transformContext?.(fakeCtx, draft)
    const contents = draft.messages.map((m) => (m as UserItem).content)
    expect(contents).toEqual(['a', 'b'])

    // 未实现的槽在手写对象上就是 undefined（与 assemblePlugins 的「空槽为 undefined」同形）。
    expect(hooks.prepareRequest).toBeUndefined()
    expect(hooks.beforeToolCall).toBeUndefined()
  })

  it('拦截型槽的返回类型可被实现并调用（编译期 + 运行期契约）', async () => {
    const hooks: LoopHooks = {
      prepareRequest(_ctx, d: RequestDraft) {
        d.messages.push(user('req'))
      },
      beforeToolCall(_ctx, ev: BeforeToolCallEvent): BeforeToolCallResult {
        return { block: true, reason: String(ev.toolCall) }
      },
      afterToolCall(_ctx, ev: AfterToolCallEvent): unknown {
        return { ...(ev.result as Record<string, unknown>), touched: true }
      },
      onTurnEnd(_ctx, _ev: TurnEndEvent): void {
        /* 观察型：无返回 */
      },
      shouldStop(): boolean {
        return true
      },
    }

    const blocked = await hooks.beforeToolCall?.(fakeCtx, { toolCall: 'shell', args: { cmd: 'ls' } })
    expect(blocked).toEqual({ block: true, reason: 'shell' })

    const rewritten = await hooks.afterToolCall?.(fakeCtx, { toolCall: 'x', result: { a: 1 } })
    expect(rewritten).toEqual({ a: 1, touched: true })

    expect(await hooks.shouldStop?.(fakeCtx)).toBe(true)

    const draft: RequestDraft = { messages: [] as ModelItem[] }
    await hooks.prepareRequest?.(fakeCtx, draft)
    expect(draft.messages).toHaveLength(1)
  })

  it('TurnEndEvent.finishReason 可为 null、toolCalls 为 unknown[]', () => {
    const ev: TurnEndEvent = { finishReason: null, toolCalls: [] }
    expect(ev.finishReason).toBeNull()
    expect(ev.toolCalls).toEqual([])

    const ev2: TurnEndEvent = { finishReason: 'tool_calls', toolCalls: [{ id: 'c1' }] }
    expect(ev2.finishReason).toBe('tool_calls')
    expect(ev2.toolCalls).toHaveLength(1)
  })

  it('Stage 2a 形状：onRunStart 槽可实现并调用；onTurnEnd 可返回 TurnEndDecision 终止决策', async () => {
    const marks: string[] = []
    const hooks: LoopHooks = {
      onRunStart(_ctx): void {
        // run 启动、首轮请求前调一次（模型迁移归一化 settings 的挂点）。
        marks.push('run-start')
      },
      onTurnEnd(_ctx, ev: TurnEndEvent): TurnEndDecision | undefined {
        // finish_reason 异常 → 要求 loop 带 'error' 状态终止（形状演示，非 loop 接线）。
        if (ev.finishReason === 'length') return { stop: true, runStatus: 'error', reason: 'length' }
        return undefined // 正常轮：不干预，loop 继续。
      },
    }

    await hooks.onRunStart?.(fakeCtx)
    expect(marks).toEqual(['run-start'])

    const stop = await hooks.onTurnEnd?.(fakeCtx, { finishReason: 'length', toolCalls: [] })
    expect(stop).toEqual({ stop: true, runStatus: 'error', reason: 'length' })

    const cont = await hooks.onTurnEnd?.(fakeCtx, { finishReason: 'stop', toolCalls: [] })
    expect(cont).toBeUndefined()
  })
})
