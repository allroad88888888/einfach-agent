// preCompact / postCompact 的触发路径（C1）。
// 这两个桶曾经的唯一触发方是上下文压缩插件（已随 A1 删除），而它从未被装配进 defaultCorePlugins——
// 于是「九个核心时机」里这两个在生产里从不触发。现在分派点挂在 modelTurnRequester
// 真正做 checkpoint 蒸馏的那一刻，前后各一次，且不经任何插件。

import { describe, expect, it, vi } from 'vitest'
import { contextCheckpointAtom, itemsAtom, runAtom } from '../state/sessionAtoms'
import { sessionsAtom } from '../state/rootStore'
import { setRun } from '../state/sessionWriters'
import type { Tool } from '../tools/types'
import type { ToolCallTiming } from '../tools/toolCallTiming'
import { createCoreInstance } from './core/coreInstance'
import { runToolLoop } from './runToolLoop'

type Core = ReturnType<typeof createCoreInstance>

const DISTILLATION_MARKER = 'Create the durable context checkpoint now. Return only the checkpoint text.'

function timedTool(name: string, callTiming: ToolCallTiming, execute: Tool['execute']): Tool {
  return {
    name,
    runtime: 'internal',
    skill: { description: name + ' 测试到点工具', content: name },
    inputSchema: { type: 'object', additionalProperties: false },
    callTiming,
    execute,
  }
}

function compactionTimingCore(order: string[]): Core {
  return createCoreInstance({
    registerTools(registry) {
      registry.register(timedTool('before_compact', 'preCompact', () => {
        order.push('preCompact')
        return { ok: true, data: '压缩前记录' }
      }))
      registry.register(timedTool('after_compact', 'postCompact', () => {
        order.push('postCompact')
        return { ok: true, data: '压缩后记录' }
      }))
    },
  })
}

function seedSession(core: Core, id: string): void {
  core.rootStore.setter(sessionsAtom, {
    [id]: {
      id,
      title: 'compaction timing',
      settings: { vendor: 'deepseek', model: 'x', max_tokens: 48_000 },
      createdAt: 0,
      updatedAt: 0,
    },
  })
}

// 一段足以逼出 checkpoint 蒸馏的历史：单条工具结果就撑爆输入预算。
function seedHistory(core: Core, id: string, toolContent: string): void {
  core.getSessionStore(id).store.setter(itemsAtom, [
    { id: 'u1', createdAt: 1, item: { role: 'user', content: '第一轮' } },
    {
      id: 'a1',
      createdAt: 2,
      item: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'skill_search', arguments: '{}' } }],
      },
    },
    { id: 't1', createdAt: 3, item: { role: 'tool', tool_call_id: 'c1', content: toolContent } },
    { id: 'u2', createdAt: 4, item: { role: 'user', content: '第二轮' } },
  ])
}

function jsonResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function toolCallIds(core: Core, id: string): string[] {
  return core.getSessionStore(id).store.getter(itemsAtom)
    .flatMap(({ item }) => item.role === 'tool' ? [item.tool_call_id] : [])
}

describe('压缩时机到点工具（不经插件）', () => {
  it('checkpoint 蒸馏前后各触发一次，产物投影成 timeline item 并进本次请求', async () => {
    const id = 'compaction-timing'
    const order: string[] = []
    const core = compactionTimingCore(order)
    seedSession(core, id)
    seedHistory(core, id, JSON.stringify({ data: 'x'.repeat(50_000) }))
    setRun(id, { runId: 'CT1', status: 'running' }, core)

    const requests: Array<Record<string, unknown>> = []
    const fetchImpl: typeof fetch = (_url, init) => {
      const body = JSON.parse(init!.body as string) as Record<string, unknown>
      requests.push(body)
      return Promise.resolve(
        JSON.stringify(body.messages).includes(DISTILLATION_MARKER)
          ? jsonResponse('第一轮工具结果已摘要。')
          : jsonResponse('好'),
      )
    }

    await runToolLoop(id, 'CT1', { signal: new AbortController().signal, apiKey: 'k', fetchImpl, core })

    // 各一次、且顺序是「蒸馏之前 → 蒸馏之后」。
    expect(order).toEqual(['preCompact', 'postCompact'])
    const ids = toolCallIds(core, id)
    expect(ids).toEqual([
      'c1',
      expect.stringMatching(/^timed:preCompact:CT1:\d+:before_compact$/),
      expect.stringMatching(/^timed:postCompact:CT1:\d+:after_compact$/),
    ])

    expect(requests).toHaveLength(2)
    const [distillation, final] = requests
    // preCompact 跑在蒸馏之前：它的结果进了待摘要的 transcript（孤儿 tool item 由请求投影补配对）。
    expect(JSON.stringify(distillation.messages)).toContain('压缩前记录')
    expect(JSON.stringify(distillation.messages)).not.toContain('压缩后记录')

    const finalMessages = final.messages as Array<Record<string, unknown>>
    const finalText = JSON.stringify(finalMessages)
    expect(finalText).toContain('Runtime context checkpoint')
    // postCompact 跑在摘要写回之后：不在 checkpoint 覆盖面里，原样跟在摘要后面进请求；
    // preCompact 的那条则已被摘要顶替（它是覆盖前缀的一部分）。
    expect(finalText).toContain('压缩后记录')
    expect(finalText).not.toContain('压缩前记录')
    const postCompactCallId = ids[2]
    expect(finalMessages.some((message) => (
      message.role === 'assistant'
      && (message.tool_calls as Array<{ id: string }> | undefined)?.some((call) => call.id === postCompactCallId)
    ))).toBe(true)

    const store = core.getSessionStore(id).store
    const preCompactItemId = store.getter(itemsAtom)
      .find(({ item }) => item.role === 'tool' && item.tool_call_id === ids[1])?.id
    expect(store.getter(contextCheckpointAtom)?.coveredItemIds).toContain(preCompactItemId)
    expect(store.getter(runAtom)?.status).toBe('done')
  })

  it('preCompact 的恢复 fence 失败时既不执行工具也不发模型请求', async () => {
    const id = 'compaction-timing-fence'
    const order: string[] = []
    const core = compactionTimingCore(order)
    seedSession(core, id)
    seedHistory(core, id, JSON.stringify({ data: 'x'.repeat(50_000) }))
    setRun(id, { runId: 'CT3', status: 'running' }, core)
    // 到点工具执行前那次快照落不下去：分派器必须在动手之前把 run 判为 interrupted。
    vi.spyOn(core.persistence, 'persistRecovery').mockImplementation(async (sessionId, reason) => (
      reason === 'tool_call_execution_started'
        ? { status: 'tombstoned', sessionId }
        : { status: 'saved', sessionId, generation: 1, attempts: 1 }
    ))
    const fetchImpl = vi.fn(async () => jsonResponse('不应请求'))

    await runToolLoop(id, 'CT3', { signal: new AbortController().signal, apiKey: 'k', fetchImpl, core })

    expect(order).toEqual([])
    // 蒸馏请求排在 preCompact 之后，所以连它都不该发出去。
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(core.getSessionStore(id).store.getter(runAtom)?.status).toBe('interrupted')
  })

  it('没超预算的空闲轮两个桶都不触发', async () => {
    const id = 'compaction-timing-idle'
    const order: string[] = []
    const core = compactionTimingCore(order)
    seedSession(core, id)
    seedHistory(core, id, JSON.stringify({ data: '短结果' }))
    setRun(id, { runId: 'CT2', status: 'running' }, core)

    let requests = 0
    const fetchImpl: typeof fetch = () => {
      requests += 1
      return Promise.resolve(jsonResponse('好'))
    }

    await runToolLoop(id, 'CT2', { signal: new AbortController().signal, apiKey: 'k', fetchImpl, core })

    expect(requests).toBe(1)
    expect(order).toEqual([])
    expect(toolCallIds(core, id)).toEqual(['c1'])
    expect(core.getSessionStore(id).store.getter(contextCheckpointAtom)).toBeUndefined()
  })
})
