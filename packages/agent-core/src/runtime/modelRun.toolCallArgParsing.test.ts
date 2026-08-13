// 拆分自 modelRun.test.ts（T1）。原文件同名 describe 段落逐字迁移。

import { describe, it, expect, afterEach } from 'vitest'
import { getSessionStore } from '../state/sessionStore'
import { itemsAtom, runAtom } from '../state/sessionAtoms'
import { toolRegistry } from '../tools/registry'
import { runSession } from './modelRun'
import { resetModelRunTestState, seedSession, jsonResponse, toolCallsResponse, rawToolCallsResponse, seqFetch } from './modelRun.testHarness'

afterEach(() => {
  resetModelRunTestState()
})

// ---------------------------------------------------------------------------
// tool_call 参数解析：坏 JSON 不执行工具，但必须回填错误结果
// ---------------------------------------------------------------------------
describe('tool_call 参数解析', () => {
  it('参数是坏 JSON：不执行工具、回填错误 tool 结果让模型重发', async () => {
    let executed = 0
    toolRegistry.register({
      name: '__args_spy__',
      runtime: 'internal',
      skill: { description: 'x', content: 'x' },
      inputSchema: {},
      execute() {
        executed += 1
        return { ok: true, data: { done: true } }
      },
    })
    seedSession('pa1', { vendor: 'deepseek', model: 'x' })
    const { fetchImpl } = seqFetch([
      () => rawToolCallsResponse('tool_calls', [{ name: '__args_spy__', args: '这不是 JSON', id: 'bad1' }]),
      () => jsonResponse('好'),
    ])

    await runSession('pa1', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    // 坏参数绝不能被降级成 {} 后照常执行 —— 那等于拿默认参数干活。
    expect(executed).toBe(0)
    const items = getSessionStore('pa1').store.getter(itemsAtom)
    const toolItem = items[3].item
    if (toolItem.role !== 'tool') throw new Error('意外的条目形状')
    const payload = JSON.parse(toolItem.content) as Record<string, unknown>
    expect(String(payload.error)).toContain('不是合法 JSON')
    expect(String(payload.hint)).toContain('JSON 对象')
  })

  it('参数是 JSON 但不是对象（数组/标量）：同样回填错误，不执行', async () => {
    let executed = 0
    toolRegistry.register({
      name: '__args_spy2__',
      runtime: 'internal',
      skill: { description: 'x', content: 'x' },
      inputSchema: {},
      execute() {
        executed += 1
        return { ok: true, data: {} }
      },
    })
    seedSession('pa2', { vendor: 'deepseek', model: 'x' })
    const { fetchImpl } = seqFetch([
      () => rawToolCallsResponse('tool_calls', [{ name: '__args_spy2__', args: '[1,2,3]', id: 'bad2' }]),
      () => jsonResponse('好'),
    ])

    await runSession('pa2', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    expect(executed).toBe(0)
    const toolItem = getSessionStore('pa2').store.getter(itemsAtom)[3].item
    if (toolItem.role !== 'tool') throw new Error('意外的条目形状')
    expect(String((JSON.parse(toolItem.content) as Record<string, unknown>).error)).toContain('必须是 JSON 对象')
  })

  it('空 arguments 仍是合法的无参调用：照常执行', async () => {
    let executed = 0
    toolRegistry.register({
      name: '__args_spy3__',
      runtime: 'internal',
      skill: { description: 'x', content: 'x' },
      inputSchema: {},
      execute() {
        executed += 1
        return { ok: true, data: { ok: 1 } }
      },
    })
    seedSession('pa3', { vendor: 'deepseek', model: 'x' })
    const { fetchImpl } = seqFetch([
      () => toolCallsResponse([{
        name: 'request_tool_schema',
        args: { toolName: '__args_spy3__', reason: '需要测试空参数' },
      }]),
      () => rawToolCallsResponse('tool_calls', [{ name: '__args_spy3__', args: '', id: 'empty1' }]),
      () => jsonResponse('好'),
    ])

    await runSession('pa3', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    expect(executed).toBe(1)
    expect(getSessionStore('pa3').store.getter(runAtom)?.status).toBe('done')
  })

  it('坏参数反复重发：签名降级用原始字符串，循环检测照样命中（不抛错）', async () => {
    seedSession('pa4', { vendor: 'deepseek', model: 'x' })
    const fetchImpl: typeof fetch = async () =>
      rawToolCallsResponse('tool_calls', [{ name: 'skill_search', args: '{"query":', id: 'loop1' }])

    await runSession('pa4', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    const run = getSessionStore('pa4').store.getter(runAtom)
    expect(run?.status).toBe('error')
    expect(run?.error).toContain('重复工具调用循环')
  })
})
