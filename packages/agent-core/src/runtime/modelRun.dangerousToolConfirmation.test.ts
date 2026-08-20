// 拆分自 modelRun.test.ts（T1）。原文件同名 describe 段落逐字迁移。

import { describe, beforeEach, it, expect, afterEach, vi } from 'vitest'
import { rootStore, sessionsAtom } from '../state/rootStore'
import { getSessionStore } from '../state/sessionStore'
import { itemsAtom, runAtom } from '../state/sessionAtoms'
import { setRun } from '../state/sessionWriters'
import { alwaysAllowedToolsAtom } from '../state/transientAtoms'
import { toolRegistry } from '../tools/registry'
import { runSession, runToolLoop } from './modelRun'
import { configureObservability, flushObservability } from '../observability/trace'
import { createCore } from './core/createCore'
import { resetModelRunTestState, seedSession, jsonResponse, toolCallsResponse, seqFetch, captureTrace, waitUntil } from './modelRun.testHarness'
import { stubHostBridgeFlag } from './hostBridge.testHarness'

// modelTurnPrefix.ts 的工具发现读 hasHostBridge()（见 runtime/hostBridge.ts）——**不是**「这是不是
// 某个特定宿主」。H4b 把总闸从宿主品牌探测改判成「宿主有没有登记 host bridge」之后，任何按品牌
// 摆布全局量的桩都会静默失效：用例仍会跑，但下面那些「本机能力在场时能发现 shell_macos」的断言
// 会变成「在没有本机能力的宿主上跑」，比失败更糟。
// 现在统一用 stubHostBridgeFlag 登记/清空 hostBridge 的 loader，它才是总闸真正读的东西。

afterEach(() => {
  resetModelRunTestState()
  stubHostBridgeFlag(false)
})

describe('危险工具确认门（S4-B）', () => {
  beforeEach(() => {
    // 这一组验证 server 工具的参数校验与授权门；只有具备本机能力的宿主会向模型暴露这些 schema。
    // 桩给的 invoke 必定 reject，因此真正被执行的 server 工具拿到的是失败结果——与改动前
    // （jsdom 里没有宿主内部通道、真 invoke 直接抛）一致，本组断言只看确认门与 ToolItem 回填。
    stubHostBridgeFlag(true)
  })

  it('危险 shell 参数缺 command：先 validation_failed 回填 tool error，不进入 waiting_confirmation', async () => {
    const trace = captureTrace()
    configureObservability({ driver: trace.driver })
    seedSession('d-shell-invalid', { vendor: 'deepseek', model: 'x' })
    const expectedError = 'invalid shell_macos: command (non-empty string) is required'
    const { fetchImpl, count } = seqFetch([
      () => toolCallsResponse([{
        name: 'request_tool_schema',
        args: { toolName: 'shell_macos', reason: '需要执行 shell' },
      }]),
      () => toolCallsResponse([{ name: 'shell_macos', args: {}, id: 'sh1' }]),
      () => jsonResponse('已处理工具参数错误'),
    ])

    await runSession('d-shell-invalid', 'hi', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
    })
    await flushObservability()

    const store = getSessionStore('d-shell-invalid').store
    const run = store.getter(runAtom)
    expect(run?.status).toBe('done')
    expect(run?.pendingToolConfirmation).toBeUndefined()
    expect(count()).toBe(3)

    const items = store.getter(itemsAtom)
    expect(items.map((it) => it.item.role)).toEqual([
      'user', 'assistant', 'tool', 'assistant', 'tool', 'assistant',
    ])
    const toolItem = items.find(
      (item) => item.item.role === 'tool' && item.item.tool_call_id === 'sh1',
    )?.item
    if (!toolItem || toolItem.role !== 'tool') throw new Error('意外的条目形状')
    expect(toolItem.tool_call_id).toBe('sh1')
    expect(toolItem.content).toBe(JSON.stringify({ error: expectedError }))
    expect(
      trace.events.some(
        (event) =>
          event.name === 'tool.validation_failed' &&
          event.attrs?.toolName === 'shell_macos' &&
          event.attrs?.callId === 'sh1' &&
          event.attrs?.validation_failed === true &&
          event.attrs?.validationError === expectedError,
      ),
    ).toBe(true)
    expect(
      trace.spans.some(
        (span) =>
          span.name === 'tool.call' &&
          span.status === 'error' &&
          span.attrs?.toolName === 'shell_macos' &&
          span.attrs?.callId === 'sh1' &&
          span.attrs?.validation_failed === true &&
          span.attrs?.validationError === expectedError,
      ),
    ).toBe(true)
    expect(trace.events.some((event) => event.name === 'agent.waiting_confirmation')).toBe(false)
  })

  it('危险工具（write_file）：暂停 waiting_confirmation + pendingToolConfirmation，循环停止、不执行、不回填', async () => {
    seedSession('d1', { vendor: 'deepseek', model: 'x' })
    const args = { path: 'a.txt', content: 'hi' }
    const { fetchImpl, count } = seqFetch([
      () => toolCallsResponse([{
        name: 'request_tool_schema',
        args: { toolName: 'write_file', reason: '需要写文件' },
      }]),
      () => toolCallsResponse([{ name: 'write_file', args, id: 'w1' }]),
      () => jsonResponse('不该到这'),
    ])

    await runSession('d1', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    const store = getSessionStore('d1').store
    const run = store.getter(runAtom)
    expect(run?.status).toBe('waiting_confirmation')
    expect(run?.pendingToolConfirmation).toEqual({
      callId: 'w1',
      toolName: 'write_file',
      args,
      registrationVersion: toolRegistry.registrationVersion('write_file'),
    })
    // schema 加载后暂停，没有续跑到最终文本。
    expect(count()).toBe(2)
    // schema call 已回填；危险工具的 ToolItem 未回填（留给 confirmTool）。
    const items = store.getter(itemsAtom)
    expect(items.map((it) => it.item.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(items.some((it) => it.item.role === 'tool' && it.item.tool_call_id === 'w1')).toBe(false)
    // 确认状态和未执行的危险 tool_call 一起覆盖进工作 checkpoint，刷新后仍由用户决定。
  })

  it('只读 server 工具（read_file）：不触发确认，正常执行并续跑到 done', async () => {
    seedSession('d2', { vendor: 'deepseek', model: 'x' })
    const { fetchImpl, count } = seqFetch([
      () => toolCallsResponse([{
        name: 'request_tool_schema',
        args: { toolName: 'read_file', reason: '需要读文件' },
      }]),
      () => toolCallsResponse([{ name: 'read_file', args: { path: 'a.txt' }, id: 'r1' }]),
      () => jsonResponse('读完了'),
    ])

    await runSession('d2', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    const store = getSessionStore('d2').store
    // 没有停在 waiting_confirmation，一路跑到 done。
    expect(store.getter(runAtom)?.status).toBe('done')
    expect(count()).toBe(3)
    // read_file 已执行并回填了 ToolItem（tool_call_id=r1）。
    const items = store.getter(itemsAtom)
    expect(items.some((it) => it.item.role === 'tool' && it.item.tool_call_id === 'r1')).toBe(true)
  })

  it('「本 session 一律允许」命中：危险工具不再确认，直接执行续跑', async () => {
    seedSession('d3', { vendor: 'deepseek', model: 'x' })
    // 预置：本 session 已一律允许 write_file。
    getSessionStore('d3').store.setter(alwaysAllowedToolsAtom, ['write_file'])
    const { fetchImpl, count } = seqFetch([
      () => toolCallsResponse([{
        name: 'request_tool_schema',
        args: { toolName: 'write_file', reason: '需要写文件' },
      }]),
      () => toolCallsResponse([{ name: 'write_file', args: { path: 'a.txt', content: 'x' }, id: 'w1' }]),
      () => jsonResponse('写完了'),
    ])

    await runSession('d3', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    const store = getSessionStore('d3').store
    expect(store.getter(runAtom)?.status).toBe('done')
    expect(count()).toBe(3)
    // write_file 已执行并回填了 ToolItem（未暂停确认）。
    const items = store.getter(itemsAtom)
    expect(items.some((it) => it.item.role === 'tool' && it.item.tool_call_id === 'w1')).toBe(true)
  })

  it('Auto：普通变更工具不确认，直接执行', async () => {
    seedSession('d-auto', { vendor: 'deepseek', model: 'x' })
    rootStore.setter(sessionsAtom, (prev) => ({
      ...prev,
      'd-auto': { ...prev['d-auto'], toolApprovalMode: 'auto' },
    }))
    const { fetchImpl, count } = seqFetch([
      () => toolCallsResponse([{
        name: 'request_tool_schema',
        args: { toolName: 'write_file', reason: '需要写文件' },
      }]),
      () => toolCallsResponse([{ name: 'write_file', args: { path: 'a.txt', content: 'x' }, id: 'w1' }]),
      () => jsonResponse('写完了'),
    ])

    await runSession('d-auto', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    expect(getSessionStore('d-auto').store.getter(runAtom)?.status).toBe('done')
    expect(count()).toBe(3)
  })

  it('Auto：rm -rf * 仍暂停为极高风险确认', async () => {
    seedSession('d-auto-critical', { vendor: 'deepseek', model: 'x' })
    rootStore.setter(sessionsAtom, (prev) => ({
      ...prev,
      'd-auto-critical': { ...prev['d-auto-critical'], toolApprovalMode: 'auto' },
    }))
    const args = { command: 'rm -rf *' }
    const { fetchImpl, count } = seqFetch([
      () => toolCallsResponse([{
        name: 'request_tool_schema',
        args: { toolName: 'shell_macos', reason: '需要执行 shell' },
      }]),
      () => toolCallsResponse([{ name: 'shell_macos', args, id: 'sh1' }]),
      () => jsonResponse('不该到这'),
    ])

    await runSession('d-auto-critical', 'hi', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
    })

    const run = getSessionStore('d-auto-critical').store.getter(runAtom)
    expect(run?.status).toBe('waiting_confirmation')
    expect(run?.pendingToolConfirmation).toMatchObject({
      callId: 'sh1',
      toolName: 'shell_macos',
      args,
      risk: 'critical',
    })
    expect(count()).toBe(2)
  })

  it('Auto：普通 rm 不暂停，但工具结果明确标记不可撤回', async () => {
    seedSession('d-auto-rm', { vendor: 'deepseek', model: 'x' })
    rootStore.setter(sessionsAtom, (prev) => ({
      ...prev,
      'd-auto-rm': { ...prev['d-auto-rm'], toolApprovalMode: 'auto' },
    }))
    const args = { command: 'rm note.txt' }
    const { fetchImpl, count } = seqFetch([
      () => toolCallsResponse([{
        name: 'request_tool_schema',
        args: { toolName: 'shell_macos', reason: '需要执行 shell' },
      }]),
      () => toolCallsResponse([{ name: 'shell_macos', args, id: 'rm1' }]),
      () => jsonResponse('执行完毕'),
    ])

    await runSession('d-auto-rm', 'hi', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
    })

    const store = getSessionStore('d-auto-rm').store
    expect(store.getter(runAtom)?.status).toBe('done')
    expect(store.getter(runAtom)?.pendingToolConfirmation).toBeUndefined()
    const result = store.getter(itemsAtom).find(
      (item) => item.item.role === 'tool' && item.item.tool_call_id === 'rm1',
    )?.item
    if (!result || result.role !== 'tool') throw new Error('缺少 rm tool result')
    expect(JSON.parse(result.content)).toMatchObject({
      details: { reversible: false },
    })
    expect(count()).toBe(3)
  })

  it('危险工具与其它 tool_call 并列：先补齐其它工具 result 再暂停确认（不 orphan）', async () => {
    seedSession('d4', { vendor: 'deepseek', model: 'x' })
    const { fetchImpl, count } = seqFetch([
      () => toolCallsResponse([{
        name: 'request_tool_schema',
        args: { toolName: 'write_file', reason: '需要写文件' },
      }]),
      () =>
        toolCallsResponse([
          { name: 'request_tool_schema', args: { toolName: 'skill_search' }, id: 'ts1' },
          { name: 'write_file', args: { path: 'a.txt', content: 'x' }, id: 'w1' },
        ]),
      () => jsonResponse('不该到这'),
    ])

    await runSession('d4', 'hi', { signal: new AbortController().signal, apiKey: 'k', fetchImpl })

    const store = getSessionStore('d4').store
    expect(store.getter(runAtom)?.status).toBe('waiting_confirmation')
    expect(count()).toBe(2)
    const items = store.getter(itemsAtom)
    // 两次 request_tool_schema 均回填；write_file 的 result 留给确认恢复。
    expect(items.map((it) => it.item.role)).toEqual([
      'user', 'assistant', 'tool', 'assistant', 'tool',
    ])
    const toolItem = items.find(
      (item) => item.item.role === 'tool' && item.item.tool_call_id === 'ts1',
    )?.item
    if (!toolItem || toolItem.role !== 'tool') throw new Error('意外的条目形状')
    expect(toolItem.tool_call_id).toBe('ts1')
    expect(items.some((it) => it.item.role === 'tool' && it.item.tool_call_id === 'w1')).toBe(false)
  })

  it('resumeToolCall：确认恢复入口先执行被确认工具、回填 result，再续跑到 done', async () => {
    seedSession('d5', { vendor: 'deepseek', model: 'x' })
    const store = getSessionStore('d5').store
    // 预置暂停前状态：user + assistant(tool_calls:[write_file w1])（w1 result 特意留空）+ pending run。
    store.setter(itemsAtom, [
      { id: 'u1', createdAt: 1, item: { role: 'user', content: 'hi' } },
      {
        id: 'a1',
        createdAt: 2,
        item: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'w1', type: 'function', function: { name: 'write_file', arguments: '{}' } }],
        },
      },
    ])
    setRun('d5', { runId: 'R1', status: 'running' })
    const fetchImpl: typeof fetch = async () => jsonResponse('最终答案')

    await runToolLoop('d5', 'R1', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
      resumeToolCall: { callId: 'w1', toolName: 'write_file', args: { path: 'a.txt', content: 'x' } },
    })

    const items = store.getter(itemsAtom)
    // 确认恢复：user → assistant(tool_calls) → tool(w1 的 result) → assistant(final)。
    expect(items.map((it) => it.item.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    const toolItem = items[2].item
    if (toolItem.role !== 'tool') throw new Error('意外的条目形状')
    expect(toolItem.tool_call_id).toBe('w1')
    expect(store.getter(runAtom)?.status).toBe('done')
  })

  it('MCP 工具等待确认后同名重注册：用户批准也不得执行新实例', async () => {
    const toolName = 'mcp__test__mutable_action'
    const oldExecute = vi.fn(() => ({ ok: true as const, data: { implementation: 'old' } }))
    const newExecute = vi.fn(() => ({ ok: true as const, data: { implementation: 'new' } }))
    let requestCount = 0
    const fetchImpl: typeof fetch = async () => {
      requestCount += 1
      if (requestCount === 1) {
        return toolCallsResponse([{
          name: 'request_tool_schema',
          args: { toolName, reason: '读取 MCP 参数' },
          id: 'load-mcp',
        }])
      }
      if (requestCount === 2) {
        return toolCallsResponse([{
          name: toolName,
          args: { value: 'approved value' },
          id: 'pending-mcp-call',
        }])
      }
      return jsonResponse('已处理注册变化')
    }
    const core = createCore({
      config: { modelCredentials: { deepseek: 'k' }, fetchImpl },
    })
    const inputSchema = {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false,
    }
    core.tools.register({
      name: toolName,
      runtime: 'internal',
      skill: { description: '旧 MCP 工具', content: '执行外部变更' },
      inputSchema,
      execute: oldExecute,
    })
    const oldRegistrationVersion = core.tools.registrationVersion(toolName)
    const id = core.newSession({ settings: { vendor: 'deepseek', model: 'x' } })

    core.sendMessage('执行 MCP 操作')
    await waitUntil(
      () => core.getSessionStore(id).store.getter(runAtom)?.status === 'waiting_confirmation'
        && !core.abort.isRunning(id),
      'MCP confirmation',
    )

    const pending = core.getSessionStore(id).store.getter(runAtom)?.pendingToolConfirmation
    expect(pending).toMatchObject({
      callId: 'pending-mcp-call',
      toolName,
      args: { value: 'approved value' },
      registrationVersion: oldRegistrationVersion,
    })
    expect(oldExecute).not.toHaveBeenCalled()

    core.tools.register({
      name: toolName,
      runtime: 'internal',
      skill: { description: '新 MCP 工具', content: '重连后的另一实现' },
      inputSchema,
      execute: newExecute,
    })
    const newRegistrationVersion = core.tools.registrationVersion(toolName)
    expect(newRegistrationVersion).toBeGreaterThan(oldRegistrationVersion!)

    // 直接走用户“允许”命令，覆盖 pending 版本从 commands 到 resumeToolCall 的完整传递。
    core.confirmTool(true)
    await waitUntil(
      () => core.getSessionStore(id).store.getter(runAtom)?.status === 'done',
      'MCP confirmation resume',
    )

    expect(oldExecute).not.toHaveBeenCalled()
    expect(newExecute).not.toHaveBeenCalled()
    const result = core.getSessionStore(id).store.getter(itemsAtom).find(
      ({ item }) => item.role === 'tool' && item.tool_call_id === 'pending-mcp-call',
    )?.item
    if (!result || result.role !== 'tool') throw new Error('缺少确认恢复后的工具结果')
    const resultPayload = JSON.parse(result.content) as { error?: string }
    expect(resultPayload.error).toContain('tool registration version mismatch')
    expect(resultPayload.error).toContain(`expected ${oldRegistrationVersion}`)
    expect(resultPayload.error).toContain(`current ${newRegistrationVersion}`)
    expect(requestCount).toBe(3)
  })
})
