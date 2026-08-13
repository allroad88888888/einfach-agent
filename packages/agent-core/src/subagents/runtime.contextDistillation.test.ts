import { describe, expect, it, vi } from 'vitest'
import {
  childPath,
  context,
  eventsOf,
  eventsTyped,
  isContextDistillationRequest,
  messagesOf,
  namedToolCall,
  orphanToolCallIds,
  requestBody,
  response,
  runtime,
  toolCall,
  toolResultFor,
} from './runtime.testHarness'

describe('createDelegateAgentRuntime · 上下文蒸馏', () => {
  it('creates a model checkpoint for an oversized child history without rewriting its raw transcript', async () => {
    // 子 agent 顶爆上下文的真实形状不是「轮数多」（HARD_MAX_TURNS=16 已经封顶），
    // 而是【单轮 payload 巨大】：read_file 把整个文件正文原样回填进 messages。
    const HUGE_HEAD = 'A'.repeat(300)
    const MIDDLE_MARKER = 'ORIGINAL_UNCOMPACTED_MIDDLE'
    const hugeFileBody = `${HUGE_HEAD}${MIDDLE_MARKER}${'B'.repeat(400_000)}TAILEND`

    const distillBodies: Record<string, unknown>[] = []
    let checkpointTurnBody: Record<string, unknown> | undefined
    let parentTurns = 0

    const runChildTool = vi.fn(async () => ({ ok: true as const, data: { content: hugeFileBody } }))
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (isContextDistillationRequest(body)) {
        distillBodies.push(body)
        return response({ content: JSON.stringify({ summary: '树形子 agent root-01。The huge file was read; continue the requested analysis.' }) })
      }
      const path = childPath(body)
      if (!path) {
        distillBodies.push(body)
        return response({ content: '# skill' })
      }
      if (path === 'root-01') {
        parentTurns += 1
        if (parentTurns === 1) return namedToolCall('read-huge', 'read_file', { path: 'src/huge.ts' })
        if (parentTurns === 2) {
          checkpointTurnBody = body
          // 第 2 轮顺手发起一次嵌套 delegate：runChildAgent 会把
          // formatSubagentTranscript(messages) 当作 parentTranscript 喂给 distill，
          // 而那份 brief 会被后代继承。它是「压缩污染了 messages」最致命的观测点。
          return toolCall('nested-1', { children: [{ objective: 'nested' }] })
        }
        return response({ content: 'parent done' })
      }
      return response({ content: 'nested done' })
    }

    const callContext = context(new Map())
    callContext.runChildTool = runChildTool
    const delegateRuntime = runtime(fetchImpl)

    const result = await delegateRuntime.delegateAgents(
      { children: [{ objective: 'analyze' }], toolProfile: 'workspace_read', maxDepth: 2 },
      callContext,
    )

    expect(result.children[0]).toMatchObject({ status: 'done', summary: 'parent done' })

    // 下一次正常请求只带模型返回的 checkpoint，不携带本地 _compacted 占位符；
    // 原始 records 留在 append-only transcript，供归档和后代 brief 使用。
    expect(checkpointTurnBody).toBeDefined()
    const checkpointText = JSON.stringify(checkpointTurnBody!.messages)
    expect(checkpointText).toContain('Runtime context checkpoint')
    expect(checkpointText).toContain('huge file was read')
    expect(checkpointText).not.toContain(MIDDLE_MARKER)
    expect(checkpointText).not.toContain('_compacted')

    // 给模型生成 checkpoint 的输入、以及后续嵌套 agent 的继承 transcript，始终是原文。
    const distillText = distillBodies.map((body) => JSON.stringify(body.messages)).join('\n')
    expect(distillText).toContain(MIDDLE_MARKER)
    expect(distillText).not.toContain('_compacted')

    delegateRuntime.dispose?.()
  })

  it('leaves a within-budget subagent request untouched', async () => {
    // 压缩只在真的超预算时才动手：正常子任务的工具正文必须逐字原样重发，
    // 否则模型每轮都在读被裁过的历史，等于凭空制造幻觉源。
    // ★ 正文长度必须【足以被摘要】（> 摘要占位保留的头 200 + 尾 100 字符），否则本用例是假绿的：
    //   短于该门槛的正文 summarizeToolResultContent 一律返回 undefined，无论预算多小都压不动，
    //   于是「预算被调坏」这件事根本不会让测试变红。5000 字符 ≈ 1250 token，远在预算内，
    //   但只要压缩逻辑真的被触发就一定会被摘掉。
    const smallFileBody = `SMALL_BODY_HEAD${'s'.repeat(5_000)}`
    let secondTurnBody: Record<string, unknown> | undefined
    const runChildTool = vi.fn(async () => ({ ok: true as const, data: { content: smallFileBody } }))
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (body.tool_choice === 'none') return response({ content: '# skill' })
      if (!messagesOf(body).some((message) => message.role === 'tool')) {
        return namedToolCall('read-small', 'read_file', { path: 'src/a.ts' })
      }
      secondTurnBody = body
      return response({ content: 'done' })
    }

    const callContext = context(new Map())
    callContext.runChildTool = runChildTool
    const delegateRuntime = runtime(fetchImpl)

    const result = await delegateRuntime.delegateAgents(
      { children: [{ objective: 'read' }], toolProfile: 'workspace_read' },
      callContext,
    )

    expect(result.children[0]).toMatchObject({ status: 'done', summary: 'done' })
    expect(secondTurnBody).toBeDefined()
    // 逐字相等 —— 不是 toContain，摘要哪怕只截掉一个字符都要红。
    expect(toolResultFor(secondTurnBody!, 'read-small')).toBe(JSON.stringify({ content: smallFileBody }))
    expect(JSON.stringify(secondTurnBody!.messages)).not.toContain('_compacted')
    expect(orphanToolCallIds(secondTurnBody!)).toEqual([])
    delegateRuntime.dispose?.()
  })

  // 一个「第 2 轮需要生成 checkpoint」的最小子 agent 场景：第 1 轮读一个巨大文件，第 2 轮的
  // messages 因此撑爆预算。摘要可观测性用例全部复用它。
  function compactingChildFetch() {
    const hugeFileBody = `HEAD${'B'.repeat(400_000)}TAIL`
    const runChildTool = vi.fn(async () => ({ ok: true as const, data: { content: hugeFileBody } }))
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (body.tool_choice === 'none') {
        return isContextDistillationRequest(body)
          ? response({ content: JSON.stringify({ summary: '树形子 agent root-01。The huge file was read.' }) })
          : response({ content: '# skill' })
      }
      if (
        messagesOf(body).some((message) =>
          message.content?.includes('Runtime context checkpoint'),
        )
      ) {
        return response({ content: 'done' })
      }
      if (!messagesOf(body).some((message) => message.role === 'tool')) {
        return namedToolCall('read-huge', 'read_file', { path: 'src/huge.ts' })
      }
      return response({ content: 'done' })
    }
    return { fetchImpl, runChildTool }
  }

  it('records model context-distillation events for the oversized subagent turn', async () => {
    const { fetchImpl, runChildTool } = compactingChildFetch()
    const writes = new Map<string, string>()
    const callContext = context(writes)
    callContext.runChildTool = runChildTool
    const delegateRuntime = runtime(fetchImpl)

    const result = await delegateRuntime.delegateAgents(
      { children: [{ objective: 'analyze' }], toolProfile: 'workspace_read' },
      callContext,
    )
    expect(result.children[0]).toMatchObject({ status: 'done', summary: 'done' })

    const started = eventsTyped(writes, 'child_context_distillation_started')
    const succeeded = eventsTyped(writes, 'child_context_distillation_succeeded')
    expect(started).toHaveLength(1)
    expect(succeeded).toHaveLength(1)
    expect(started[0].agentPath).toBe('root-01')
    expect(succeeded[0].agentPath).toBe('root-01')
    const startData = started[0].data ?? {}
    const successData = succeeded[0].data ?? {}
    // 第 1 轮（只有 [system, user]）远在预算内；第 2 轮才交给模型生成 checkpoint。
    expect(startData.turn).toBe(2)
    expect(startData.sourceMessages).toBe(4)
    expect(startData.inputBudgetTk as number).toBeGreaterThan(0)
    expect(successData.turn).toBe(2)
    expect(successData.sourceMessages).toBe(4)
    expect(successData.summaryChars as number).toBeGreaterThan(0)
    expect(successData.sourceEstimatedTk as number).toBeGreaterThan(startData.inputBudgetTk as number)
    expect(eventsTyped(writes, 'child_context_distillation_failed')).toHaveLength(0)
    delegateRuntime.dispose?.()
  })

  it('records no context-distillation event when every subagent turn stays within budget', async () => {
    const smallFileBody = `SMALL${'s'.repeat(5_000)}`
    const runChildTool = vi.fn(async () => ({ ok: true as const, data: { content: smallFileBody } }))
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (body.tool_choice === 'none') return response({ content: '# skill' })
      if (!messagesOf(body).some((message) => message.role === 'tool')) {
        return namedToolCall('read-small', 'read_file', { path: 'src/a.ts' })
      }
      return response({ content: 'done' })
    }
    const writes = new Map<string, string>()
    const callContext = context(writes)
    callContext.runChildTool = runChildTool
    const delegateRuntime = runtime(fetchImpl)

    const result = await delegateRuntime.delegateAgents(
      { children: [{ objective: 'read' }], toolProfile: 'workspace_read' },
      callContext,
    )

    expect(result.children[0]).toMatchObject({ status: 'done', summary: 'done' })
    // 事件日志本身非空（说明确实在记事件，不是路径找错了导致的空数组假绿）。
    expect(eventsOf(writes).length).toBeGreaterThan(0)
    expect(eventsTyped(writes, 'child_context_distillation_started')).toHaveLength(0)
    expect(eventsTyped(writes, 'child_context_distillation_succeeded')).toHaveLength(0)
    expect(eventsTyped(writes, 'child_context_distillation_failed')).toHaveLength(0)
    delegateRuntime.dispose?.()
  })

  it('distills an oversized initial objective instead of sending an over-budget raw request', async () => {
    const hugeObjective = `analyze ${'x'.repeat(400_000)}`
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (body.tool_choice !== 'none') return response({ content: 'done' })
      return isContextDistillationRequest(body)
        ? response({ content: JSON.stringify({ summary: 'Analyze the requested objective.' }) })
        : response({ content: '# skill' })
    }
    const writes = new Map<string, string>()
    const delegateRuntime = runtime(fetchImpl)

    const result = await delegateRuntime.delegateAgents(
      { children: [{ objective: hugeObjective }] },
      context(writes),
    )

    expect(result.children[0]).toMatchObject({ status: 'done', summary: 'done' })

    const started = eventsTyped(writes, 'child_context_distillation_started')
    const succeeded = eventsTyped(writes, 'child_context_distillation_succeeded')
    // 一次发生在 child brief 蒸馏，一次发生在实际子 agent 的第一轮请求；二者均由模型摘要后继续。
    expect(started).toHaveLength(2)
    expect(succeeded).toHaveLength(2)
    expect(started.some((event) => event.data?.phase === 'subagent')).toBe(true)
    expect(started.some((event) => event.data?.phase === 'distill:child_brief')).toBe(true)
    expect(eventsTyped(writes, 'child_context_distillation_failed')).toHaveLength(0)
    delegateRuntime.dispose?.()
  })

  it('keeps the subagent finishing normally when a context-distillation event write fails', async () => {
    // 可观测性代码永远不该有能力让被观测的东西失败。这正是 bestEffortRecordEvent 与
    // recordEvent 的唯一差别：后者会把写盘异常抛给 callModel，一路冒到 runChildAgent 的 catch，
    // 于是「记日志失败」伪装成「子 agent 失败」回填给父 agent。
    const { fetchImpl, runChildTool } = compactingChildFetch()
    const writes = new Map<string, string>()
    const callContext = context(writes)
    callContext.runChildTool = runChildTool
    const passthrough = callContext.writeTextFile!
    const rejected: string[] = []
    callContext.writeTextFile = async (input) => {
      // 只掐摘要成功事件那一次写，其余归档写照常 —— 否则失败原因会混进别的链路，测不准。
      if (input.content.includes('"child_context_distillation_succeeded"')) {
        rejected.push(input.path)
        throw new Error('archive host is gone')
      }
      return passthrough(input)
    }
    const delegateRuntime = runtime(fetchImpl)

    const result = await delegateRuntime.delegateAgents(
      { children: [{ objective: 'analyze' }], toolProfile: 'workspace_read' },
      callContext,
    )

    // 确实走到了那条写（否则下面的「仍然 done」是空断言）。
    expect(rejected.length).toBeGreaterThan(0)
    expect(result.children[0]).toMatchObject({ status: 'done', summary: 'done' })
    // 事件没落盘，但子 agent 的产出与状态完好。
    expect(eventsTyped(writes, 'child_context_distillation_succeeded')).toHaveLength(0)
    delegateRuntime.dispose?.()
  })
})
