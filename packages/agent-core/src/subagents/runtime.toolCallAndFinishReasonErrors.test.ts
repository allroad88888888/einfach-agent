import { describe, expect, it, vi } from 'vitest'
import { FINISH_REASON_ERRORS } from '../runtime/finishReason'
import type { SubagentNodeRecord } from './types'
import {
  context,
  finishedResponse,
  messagesOf,
  namedToolCall,
  orphanToolCallIds,
  rawArgsToolCall,
  requestBody,
  response,
  runtime,
  toolResultFor,
} from './runtime.testHarness'

describe('createDelegateAgentRuntime · 工具参数与 finish_reason 异常', () => {
  // ---------------------------------------------------------------------------
  // 坏 JSON 工具参数（子 agent 循环）
  // ---------------------------------------------------------------------------
  // 回归背景：这条子循环曾用 safeParseArgs，把被 finish_reason='length' 截断的半截 arguments
  // 静默降级成 {} 再照常执行工具 —— 子 agent 只会收到一个误导性的「缺参数」报错，去改参数值
  // 而不是重发 JSON。现在改成：不执行工具 + 回填一条说明 JSON 坏了的 tool 结果。
  it('does not execute a tool whose arguments are truncated JSON and backfills a parse error', async () => {
    const runChildTool = vi.fn(async () => ({ ok: true as const, data: { content: 'private-file-body' } }))
    let secondTurnBody: Record<string, unknown> | undefined
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (body.tool_choice === 'none') return response({ content: '# skill' })
      if (!messagesOf(body).some((message) => message.role === 'tool')) {
        // 模型被截断，吐出半截 arguments。
        return rawArgsToolCall('bad-args-1', 'read_file', '{"path": "src/a.t')
      }
      secondTurnBody = body
      return response({ content: 'resent with valid json' })
    }
    const callContext = context(new Map())
    callContext.runChildTool = runChildTool
    const delegateRuntime = runtime(fetchImpl)

    const result = await delegateRuntime.delegateAgents(
      { children: [{ objective: 'read' }], toolProfile: 'workspace_read' },
      callContext,
    )

    // 工具没被执行（旧实现会拿 {} 去调 read_file）。
    expect(runChildTool).not.toHaveBeenCalled()
    // 但结果被回填了，循环得以继续。
    expect(secondTurnBody).toBeDefined()
    expect(orphanToolCallIds(secondTurnBody!)).toEqual([])
    const toolResult = JSON.parse(toolResultFor(secondTurnBody!, 'bad-args-1')) as Record<string, string>
    expect(toolResult.error).toContain('不是合法 JSON')
    expect(toolResult.hint).toContain('完整合法的 JSON 对象')
    expect(toolResult.argumentsPreview).toBe('{"path": "src/a.t')
    expect(result.children[0]).toMatchObject({ status: 'done', summary: 'resent with valid json' })
    delegateRuntime.dispose?.()
  })

  it('rejects a delegate_agent call with non-object arguments instead of delegating', async () => {
    let secondTurnBody: Record<string, unknown> | undefined
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (body.tool_choice === 'none') return response({ content: '# skill' })
      if (!messagesOf(body).some((message) => message.role === 'tool')) {
        // 合法 JSON，但不是对象 —— 同样不能拿它当 {} 去派生下一层。
        return rawArgsToolCall('bad-args-2', 'delegate_agent', '["grandchild"]')
      }
      secondTurnBody = body
      return response({ content: 'nested delegation skipped' })
    }
    const delegateRuntime = runtime(fetchImpl)

    const result = await delegateRuntime.delegateAgents(
      { children: [{ objective: 'parent' }], maxDepth: 3 },
      context(new Map()),
    )

    expect(secondTurnBody).toBeDefined()
    expect(orphanToolCallIds(secondTurnBody!)).toEqual([])
    const toolResult = JSON.parse(toolResultFor(secondTurnBody!, 'bad-args-2')) as Record<string, string>
    expect(toolResult.error).toContain('必须是 JSON 对象')
    expect(toolResult.error).toContain('array')
    expect(result.children[0]).toMatchObject({ status: 'done', summary: 'nested delegation skipped' })
    // 只有 parent 一个节点被计费 —— 坏参数没有派生出孙子节点。
    expect(result.summary).toMatchObject({ total: 1, done: 1, failed: 0 })
    delegateRuntime.dispose?.()
  })

  it('backfills every tool call when one of a sibling batch has bad arguments', async () => {
    const runChildTool = vi.fn(async () => ({ ok: true as const, data: { content: 'good-file-body' } }))
    let secondTurnBody: Record<string, unknown> | undefined
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (body.tool_choice === 'none') return response({ content: '# skill' })
      if (!messagesOf(body).some((message) => message.role === 'tool')) {
        return response({
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'sib-bad', type: 'function', function: { name: 'read_file', arguments: '{"path": ' } },
            {
              id: 'sib-good',
              type: 'function',
              function: { name: 'read_file', arguments: JSON.stringify({ path: 'src/b.ts' }) },
            },
          ],
        })
      }
      secondTurnBody = body
      return response({ content: 'partial batch handled' })
    }
    const callContext = context(new Map())
    callContext.runChildTool = runChildTool
    const delegateRuntime = runtime(fetchImpl)

    const result = await delegateRuntime.delegateAgents(
      { children: [{ objective: 'read' }], toolProfile: 'workspace_read' },
      callContext,
    )

    // 坏的那条被拒，好的那条照常执行 —— 坏参数不能连累兄弟调用。
    expect(runChildTool).toHaveBeenCalledTimes(1)
    expect(runChildTool).toHaveBeenCalledWith(
      'read_file',
      { path: 'src/b.ts' },
      expect.any(Number),
    )
    expect(secondTurnBody).toBeDefined()
    expect(orphanToolCallIds(secondTurnBody!)).toEqual([])
    expect(toolResultFor(secondTurnBody!, 'sib-bad')).toContain('不是合法 JSON')
    expect(toolResultFor(secondTurnBody!, 'sib-good')).toContain('good-file-body')
    expect(result.children[0]).toMatchObject({ status: 'done', summary: 'partial batch handled' })
    delegateRuntime.dispose?.()
  })

  it('still treats empty arguments as a valid no-arg call', async () => {
    const runChildTool = vi.fn(async () => ({ ok: true as const, data: { content: 'listed' } }))
    let secondTurnBody: Record<string, unknown> | undefined
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (body.tool_choice === 'none') return response({ content: '# skill' })
      if (!messagesOf(body).some((message) => message.role === 'tool')) {
        // 空 arguments 是无参工具的合法形态，不是解析失败 —— 不能被新分支误伤。
        return rawArgsToolCall('empty-args', 'read_file', '   ')
      }
      secondTurnBody = body
      return response({ content: 'no-arg call executed' })
    }
    const callContext = context(new Map())
    callContext.runChildTool = runChildTool
    const delegateRuntime = runtime(fetchImpl)

    const result = await delegateRuntime.delegateAgents(
      { children: [{ objective: 'list' }], toolProfile: 'workspace_read' },
      callContext,
    )

    expect(runChildTool).toHaveBeenCalledWith('read_file', {}, expect.any(Number))
    expect(secondTurnBody).toBeDefined()
    expect(toolResultFor(secondTurnBody!, 'empty-args')).not.toContain('不是合法 JSON')
    expect(result.children[0]).toMatchObject({ status: 'done', summary: 'no-arg call executed' })
    delegateRuntime.dispose?.()
  })

  // ---------------------------------------------------------------------------
  // finish_reason 异常三态（子 agent 循环）
  // ---------------------------------------------------------------------------
  // 回归背景：子循环从头到尾没读过 finish_reason，于是 toolCalls.length === 0 的收尾路径会把
  // 【被截断的半截 content】原样写进 result.md 并把节点标成 'done' —— 一个残缺答案以「成功」
  // 身份回填给父 agent，还会经 distill 传给后代，父/兄弟 agent 都无从知道它是半截的。
  // content_filter / insufficient_system_resource 时 content 为空，落到兜底文案后同样标 'done'。
  it('fails a child whose final answer was truncated by finish_reason=length instead of marking it done', async () => {
    const runChildTool = vi.fn(async () => ({ ok: true as const, data: { content: 'file-body' } }))
    let truncatedTurnBody: Record<string, unknown> | undefined
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (body.tool_choice === 'none') return response({ content: '# skill' })
      if (!messagesOf(body).some((message) => message.role === 'tool')) {
        return namedToolCall('read-ok', 'read_file', { path: 'src/a.ts' })
      }
      truncatedTurnBody = body
      // 模型开始写结论就被掐断：content 是半截文本，finish_reason='length'。
      return finishedResponse({ content: '结论：该模块可以安全删除，因为它的唯一调用点在' }, 'length')
    }
    const callContext = context(new Map())
    callContext.runChildTool = runChildTool
    const writes = new Map<string, string>()
    callContext.writeTextFile = async (input) => {
      writes.set(input.path, input.mode === 'append' ? `${writes.get(input.path) ?? ''}${input.content}` : input.content)
      return { ok: true }
    }
    const delegateRuntime = runtime(fetchImpl)

    const result = await delegateRuntime.delegateAgents(
      { children: [{ objective: 'analyze' }], toolProfile: 'workspace_read' },
      callContext,
    )

    const child = result.children[0]
    // 核心断言：残缺产出【不能】以 'done' 身份回填。
    expect(child.status).not.toBe('done')
    expect(child.status).toBe('failed')
    // 父 agent 能明确看到「不完整」以及精确成因。
    expect(child.error).toContain(FINISH_REASON_ERRORS.length)
    expect(child.summary).toBe(child.error)
    // 半截文本只作为定位线索出现，且被明确标注成不完整。
    expect(child.error).toContain('截断片段（仅供定位，不完整）')
    expect(child.error).toContain('结论：该模块可以安全删除')
    // 没有 result.md 被当成有效产出登记 —— resultFile 必须为空，且不得写出正式的 result.md。
    expect(child.resultFile).toBeUndefined()
    const resultWrites = [...writes.keys()].filter((path) => path.includes('/results/'))
    expect(resultWrites.some((path) => /result\.md$/.test(path))).toBe(false)
    // 但完整残稿【要留住】：只在最后一句被掐断的几千字产出仍然有效，父 agent 应能复用而不是整体重跑。
    // 它落在 result.partial.md（而非 result.md），状态仍是 failed —— 采信与否由父 agent 显式决定。
    const partialWrites = resultWrites.filter((path) => /result\.partial\.md$/.test(path))
    expect(partialWrites).toHaveLength(1)
    expect(writes.get(partialWrites[0])).toContain('结论：该模块可以安全删除')
    expect(child.error).toContain('完整残稿已存至')
    // 树节点同样是 failed，不是 done。
    const tree = JSON.parse([...writes.entries()].find(([path]) => path.endsWith('/tree.json'))?.[1] ?? '{}') as {
      nodes: SubagentNodeRecord[]
    }
    expect(tree.nodes.find((node) => node.path === 'root-01')?.status).toBe('failed')
    // parallel_wait_all 下整批判失败，父 agent 不会拿着半截结论继续往下走。
    expect(result.status).toBe('failed')
    expect(result.summary).toMatchObject({ total: 1, done: 0, failed: 1 })
    // 上一轮【已完成】的 tool 结果回填不受影响：截断发生在下一轮，消息序列始终合法。
    expect(truncatedTurnBody).toBeDefined()
    expect(orphanToolCallIds(truncatedTurnBody!)).toEqual([])
    expect(toolResultFor(truncatedTurnBody!, 'read-ok')).toContain('file-body')
    expect(runChildTool).toHaveBeenCalledWith(
      'read_file',
      { path: 'src/a.ts' },
      expect.any(Number),
    )
    delegateRuntime.dispose?.()
  })

  it('fails a child whose output was blocked by finish_reason=content_filter', async () => {
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (body.tool_choice === 'none') return response({ content: '# skill' })
      // 被安全策略拦截：content 为空。旧实现会落到 '子 agent 未返回有效文本。' 兜底并标 'done'。
      return finishedResponse({ content: '' }, 'content_filter')
    }
    const writes = new Map<string, string>()
    const delegateRuntime = runtime(fetchImpl)

    const result = await delegateRuntime.delegateAgents(
      { children: [{ objective: 'summarize' }] },
      context(writes),
    )

    const child = result.children[0]
    expect(child.status).not.toBe('done')
    expect(child.status).toBe('failed')
    expect(child.error).toContain(FINISH_REASON_ERRORS.content_filter)
    // 不能再伪装成「跑完了但没话说」。
    expect(child.summary).not.toContain('子 agent 未返回有效文本')
    expect(child.resultFile).toBeUndefined()
    const tree = JSON.parse([...writes.entries()].find(([path]) => path.endsWith('/tree.json'))?.[1] ?? '{}') as {
      nodes: SubagentNodeRecord[]
    }
    expect(tree.nodes.find((node) => node.path === 'root-01')?.status).toBe('failed')
    // 归档事件里也记的是 failed，replay 出来的树不会有假成功。
    const eventsText = [...writes.entries()].find(([path]) => path.endsWith('/events.jsonl'))?.[1] ?? ''
    const finished = eventsText
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; agentPath: string; data?: Record<string, unknown> })
      .find((event) => event.type === 'child_finished' && event.agentPath === 'root-01')
    expect(finished?.data?.status).toBe('failed')
    expect(String(finished?.data?.error)).toContain('finish_reason=content_filter')
    delegateRuntime.dispose?.()
  })

  it('fails a child when the model reports insufficient_system_resource', async () => {
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (body.tool_choice === 'none') return response({ content: '# skill' })
      return finishedResponse({ content: '' }, 'insufficient_system_resource')
    }
    const delegateRuntime = runtime(fetchImpl)

    const result = await delegateRuntime.delegateAgents(
      // best_effort：容量不足的子 agent 应当把整批降级成 partial 语义，而不是假装成功。
      { children: [{ objective: 'a' }, { objective: 'b' }], strategy: 'parallel_best_effort' },
      context(new Map()),
    )

    expect(result.children.map((child) => child.status)).toEqual(['failed', 'failed'])
    expect(result.children[0].error).toContain(FINISH_REASON_ERRORS.insufficient_system_resource)
    // 三态文案各不相同：父 agent 据此选择重试而不是改写任务。
    expect(result.children[0].error).not.toContain('finish_reason=length')
    expect(result.children[0].error).not.toContain('content_filter')
    expect(result.status).toBe('failed')
    expect(result.summary).toMatchObject({ total: 2, done: 0, failed: 2 })
    delegateRuntime.dispose?.()
  })

  it('keeps the truncated-arguments gate working when finish_reason=length arrives with tool calls', async () => {
    const runChildTool = vi.fn(async () => ({ ok: true as const, data: { content: 'good-body' } }))
    let thirdTurnBody: Record<string, unknown> | undefined
    let turn = 0
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (body.tool_choice === 'none') return response({ content: '# skill' })
      turn += 1
      if (turn === 1) {
        // 触顶【且】带 tool_calls：不能在这里终止整个子 agent，否则上一轮补的坏 JSON 闸门就废了。
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    { id: 'cut-args', type: 'function', function: { name: 'read_file', arguments: '{"path": "src/a' } },
                  ],
                },
                finish_reason: 'length',
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      if (turn === 2) return namedToolCall('retry-ok', 'read_file', { path: 'src/a.ts' })
      thirdTurnBody = body
      return response({ content: 'recovered and answered' })
    }
    const callContext = context(new Map())
    callContext.runChildTool = runChildTool
    const delegateRuntime = runtime(fetchImpl)

    const result = await delegateRuntime.delegateAgents(
      { children: [{ objective: 'read' }], toolProfile: 'workspace_read' },
      callContext,
    )

    // 半截 arguments 没被执行，但循环没被 finish_reason 分流掐死 —— 子 agent 重发后恢复。
    expect(runChildTool).toHaveBeenCalledTimes(1)
    expect(runChildTool).toHaveBeenCalledWith(
      'read_file',
      { path: 'src/a.ts' },
      expect.any(Number),
    )
    expect(thirdTurnBody).toBeDefined()
    expect(orphanToolCallIds(thirdTurnBody!)).toEqual([])
    expect(toolResultFor(thirdTurnBody!, 'cut-args')).toContain('不是合法 JSON')
    expect(toolResultFor(thirdTurnBody!, 'retry-ok')).toContain('good-body')
    expect(result.children[0]).toMatchObject({ status: 'done', summary: 'recovered and answered' })
    delegateRuntime.dispose?.()
  })

  it('marks a distilled skill as incomplete when the distillation itself was truncated', async () => {
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      // 蒸馏调用本身触顶：skill 正文会被子孙 agent 继承，截断信息不能在这条链路上丢失。
      if (body.tool_choice === 'none') return finishedResponse({ content: '# 半截 brief' }, 'length')
      return response({ content: 'child answered' })
    }
    const writes = new Map<string, string>()
    const delegateRuntime = runtime(fetchImpl)

    const result = await delegateRuntime.delegateAgents(
      { children: [{ objective: 'work' }] },
      context(writes),
    )

    // 不 throw：整批不因为一次蒸馏截断而失败。
    expect(result.children[0].status).toBe('done')
    const skillWrite = [...writes.entries()].find(([path]) => path.includes('/skills/'))?.[1] ?? ''
    expect(skillWrite).toContain('# 半截 brief')
    expect(skillWrite).toContain('finish_reason=length')
    expect(skillWrite).toContain('本 skill 内容不完整')
    delegateRuntime.dispose?.()
  })
})
