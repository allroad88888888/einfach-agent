import { describe, expect, it, vi } from 'vitest'
import { createToolRegistry } from '../tools/toolRegistry'
import {
  childPath,
  context,
  messagesOf,
  namedToolCall,
  requestBody,
  response,
  runtime,
  toolResultFor,
} from './runtime.testHarness'
import { createTestDelegationRuntime } from './runtime.ports.testFixtures'

describe('createDelegationRuntime · 工具档位与注册表装载', () => {
  it('keeps child agents delegate-only by default and rejects workspace reads', async () => {
    const runChildTool = vi.fn(async () => ({ ok: true as const, data: { content: 'secret' } }))
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (body.tool_choice === 'none') return response({ content: '# skill' })
      const messages = body.messages as Array<{ role: string; content?: string }>
      if (!messages.some((message) => message.role === 'tool')) {
        return namedToolCall('read-1', 'read_file', { path: 'src/a.ts' })
      }
      expect(messages.find((message) => message.role === 'tool')?.content).toContain(
        'tool not allowed for child agent: read_file',
      )
      return response({ content: 'recovered' })
    }
    const callContext = context(new Map())
    callContext.runChildTool = runChildTool
    const delegateRuntime = runtime(fetchImpl)

    const result = await delegateRuntime.delegateAgents({ children: [{ objective: 'read' }] }, callContext)

    expect(result.children[0]).toMatchObject({ status: 'done', summary: 'recovered' })
    expect(runChildTool).not.toHaveBeenCalled()
    delegateRuntime.dispose?.()
  })

  it('allows workspace reads when opted in without archiving file contents', async () => {
    const writes = new Map<string, string>()
    const runChildTool = vi.fn(async () => ({ ok: true as const, data: { content: 'private-file-body' } }))
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (body.tool_choice === 'none') return response({ content: '# skill' })
      const messages = body.messages as Array<{ role: string; content?: string }>
      if (!messages.some((message) => message.role === 'tool')) {
        return namedToolCall('read-2', 'read_file', { path: 'src/a.ts' })
      }
      expect(messages.find((message) => message.role === 'tool')?.content).toContain('private-file-body')
      return response({ content: 'read complete' })
    }
    const callContext = context(writes)
    callContext.runChildTool = runChildTool
    const delegateRuntime = runtime(fetchImpl)

    const result = await delegateRuntime.delegateAgents(
      { children: [{ objective: 'read' }], toolProfile: 'workspace_read' },
      callContext,
    )

    expect(result.children[0]).toMatchObject({ status: 'done', summary: 'read complete' })
    expect(runChildTool).toHaveBeenCalledWith(
      'read_file',
      { path: 'src/a.ts' },
      expect.any(Number),
    )
    const eventsText = [...writes.entries()].find(([path]) => path.endsWith('/events.jsonl'))?.[1] ?? ''
    expect(eventsText).toContain('child_tool_finished')
    expect(eventsText).toContain('workspace_read')
    expect(eventsText).not.toContain('private-file-body')
    delegateRuntime.dispose?.()
  })

  it('dispatches the verification tool for workspace_verify and permits project shell commands', async () => {
    const writes = new Map<string, string>()
    const runChildTool = vi.fn(async () => ({
      ok: true as const,
      data: { exitCode: 0, stdout: '6 passed', stderr: '' },
    }))
    const systemPrompts: string[] = []
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (body.tool_choice === 'none') return response({ content: '# skill' })
      const messages = messagesOf(body)
      if (childPath(body)) systemPrompts.push(messages[0]?.content ?? '')
      if (!messages.some((message) => message.role === 'tool')) {
        return namedToolCall('verify-1', 'run_verification_command', { command: 'pnpm test' })
      }
      expect(toolResultFor(body, 'verify-1')).toContain('6 passed')
      return response({ content: 'verified' })
    }
    const callContext = context(writes)
    callContext.runChildTool = runChildTool
    const delegateRuntime = runtime(fetchImpl)

    const result = await delegateRuntime.delegateAgents(
      {
        children: [{ objective: 'verify stage' }],
        toolProfile: 'workspace_verify',
      },
      callContext,
    )

    expect(result.children[0]).toMatchObject({ status: 'done', summary: 'verified' })
    expect(runChildTool).toHaveBeenCalledWith(
      'run_verification_command',
      { command: 'pnpm test' },
      expect.any(Number),
    )
    expect(systemPrompts[0]).toContain('run_verification_command')
    expect(systemPrompts[0]).toContain('验收所需的 shell 命令及项目脚本')
    delegateRuntime.dispose?.()
  })

  it('states the shell verification capability for every workspace_verify child', async () => {
    const writes = new Map<string, string>()
    const systemPrompts: string[] = []
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (body.tool_choice === 'none') return response({ content: '# skill' })
      if (childPath(body)) systemPrompts.push(messagesOf(body)[0]?.content ?? '')
      return response({ content: 'no evidence available' })
    }
    const callContext = context(writes)
    const delegateRuntime = runtime(fetchImpl)

    await delegateRuntime.delegateAgents(
      { children: [{ objective: 'verify stage' }], toolProfile: 'workspace_verify' },
      callContext,
    )

    expect(systemPrompts[0]).toContain('run_verification_command')
    expect(systemPrompts[0]).toContain('验收所需的 shell 命令及项目脚本')
    delegateRuntime.dispose?.()
  })

  it('keeps the verification tool out of reach for workspace_read children', async () => {
    const runChildTool = vi.fn(async () => ({ ok: true as const, data: { stdout: 'ran' } }))
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (body.tool_choice === 'none') return response({ content: '# skill' })
      const messages = messagesOf(body)
      if (!messages.some((message) => message.role === 'tool')) {
        return namedToolCall('verify-2', 'run_verification_command', { command: 'pnpm test' })
      }
      expect(toolResultFor(body, 'verify-2')).toContain(
        'tool not allowed for child agent: run_verification_command',
      )
      return response({ content: 'recovered' })
    }
    const callContext = context(new Map())
    callContext.runChildTool = runChildTool
    const delegateRuntime = runtime(fetchImpl)

    const result = await delegateRuntime.delegateAgents(
      { children: [{ objective: 'read' }], toolProfile: 'workspace_read' },
      callContext,
    )

    expect(result.children[0]).toMatchObject({ status: 'done', summary: 'recovered' })
    expect(runChildTool).not.toHaveBeenCalled()
    delegateRuntime.dispose?.()
  })

  // 一个 runtime 服务整轮 run 的多次 root 委派：模型自己派的只读调研，和 submit_stage_result
  // 拉起的 workspace_verify 评估器，都从 root 发起。root 的档位来自宿主而非上一次 root 调用 ——
  // 曾经在首次调用里锁死 root 档位，于是「先 workspace_read 调研、后 workspace_verify 评估」
  // 必然报 cannot widen inherited workspace_read，评估器起不来、阶段被回滚。
  it('每次 root 委派各自决定 toolProfile，既不被上一次锁死也不靠省略继承', async () => {
    const runChildTool = vi.fn(async (name: string) => (
      name === 'run_verification_command'
        ? { ok: true as const, data: { exitCode: 0, stdout: '6 passed', stderr: '' } }
        : { ok: true as const, data: { content: 'file body' } }
    ))
    const toolResults: string[] = []
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (body.tool_choice === 'none') return response({ content: '# skill' })
      const messages = messagesOf(body)
      if (messages.some((message) => message.role === 'tool')) {
        toolResults.push(messages
          .filter((message) => message.role === 'tool')
          .map((message) => message.content ?? '')
          .join('\n'))
        return response({ content: 'done' })
      }
      return messages.some((message) => message.content?.includes('verify stage'))
        ? namedToolCall('verify-root', 'run_verification_command', { command: 'pnpm test' })
        : namedToolCall('read-root', 'read_file', { path: 'src/a.ts' })
    }
    const callContext = context(new Map())
    callContext.runChildTool = runChildTool
    const delegateRuntime = runtime(fetchImpl)

    const research = await delegateRuntime.delegateAgents(
      { children: [{ objective: 'research' }], toolProfile: 'workspace_read' },
      callContext,
    )
    const evaluator = await delegateRuntime.delegateAgents(
      { children: [{ objective: 'verify stage' }], toolProfile: 'workspace_verify' },
      callContext,
    )
    const omitted = await delegateRuntime.delegateAgents(
      { children: [{ objective: 'plain' }] },
      callContext,
    )

    expect(research.children[0]).toMatchObject({ status: 'done', summary: 'done' })
    expect(evaluator.children[0]).toMatchObject({ status: 'done', summary: 'done' })
    expect(omitted.children[0]).toMatchObject({ status: 'done', summary: 'done' })
    expect(runChildTool).toHaveBeenNthCalledWith(1, 'read_file', { path: 'src/a.ts' }, expect.any(Number))
    expect(runChildTool).toHaveBeenNthCalledWith(2, 'run_verification_command', { command: 'pnpm test' }, expect.any(Number))
    // 省略 toolProfile 的 root 调用回落 delegate_only，不白捡上一次 root 调用的档位。
    expect(runChildTool).toHaveBeenCalledTimes(2)
    expect(toolResults[2]).toContain('tool not allowed for child agent: read_file')
    delegateRuntime.dispose?.()
  })

  // 孩子的 maxTurns 默认只有 4 且最后一轮留给合成，先花一整轮做能力发现等于砍掉三分之一预算。
  // 授权集在 spawn 时就已收窄到个位数，整体预载即可，于是「直接调用」在第一轮就能真干活。
  it('预载整个授权集：孩子首轮直接调用即执行，不为能力发现白烧一轮', async () => {
    const childBodies: Record<string, unknown>[] = []
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (!childPath(body)) return response({ content: '# skill' })
      childBodies.push(body)
      // 第一轮就不先 request_tool_schema，直接指名道姓调用 —— 正是主循环里撞闸门的那个行为。
      if (childBodies.length === 1) {
        return namedToolCall('first-read', 'read_file', { path: 'src/a.ts' })
      }
      return response({ role: 'assistant', content: '读完了。' })
    }
    const runChildTool = vi.fn(async () => ({ ok: true as const, data: { content: 'file body' } }))
    const callContext = context(new Map())
    callContext.runChildTool = runChildTool
    const delegateRuntime = runtime(fetchImpl)

    const result = await delegateRuntime.delegateAgents({
      children: [{
        objective: 'inspect',
        mode: 'worker',
        expectedOutput: 'summary',
        maxTurns: 3,
        toolProfile: 'workspace_read',
      }],
      toolProfile: 'workspace_read',
    }, callContext)

    const firstTurnTools = (childBodies[0].tools as Array<{ function: { name: string } }>)
      .map((tool) => tool.function.name)
    expect(firstTurnTools).toEqual(expect.arrayContaining([
      'request_tool_schema',
      'delegate_agent',
      'read_file',
      'list_files',
      'search_files',
      'rg_search',
    ]))
    // 首轮那次直接调用真的执行了（没有被闸门转成一次加载）。
    expect(runChildTool).toHaveBeenCalledTimes(1)
    expect(runChildTool).toHaveBeenCalledWith('read_file', { path: 'src/a.ts' }, expect.any(Number))
    expect(result.children[0].status).toBe('done')
    await delegateRuntime.dispose?.()
  })

  // 与主循环逐条对齐：判据是「本轮实际发出去的 tools」。注册态中途变化把工具挤出本轮 tools 时，
  // 直接调用【不执行】，改当作一次加载 —— 旧行为是「已授权就直接跑」，会拿模型猜的参数执行。
  it('授权工具不在本轮 tools 里时：直接调用不执行，就地加载后下一轮回到 tools', async () => {
    const isolatedRegistry = createToolRegistry()
    const readFileTool = {
      name: 'read_file',
      runtime: 'server' as const,
      skill: { description: 'isolated reader', content: 'GUIDE' },
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
      execute: async () => ({ ok: true as const, data: { source: 'isolated' } }),
    }
    isolatedRegistry.register(readFileTool)
    isolatedRegistry.register({
      ...readFileTool,
      name: 'list_files',
      skill: { description: 'isolated lister', content: 'GUIDE' },
    })

    const childBodies: Record<string, unknown>[] = []
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (!childPath(body)) return response({ content: '# skill' })
      childBodies.push(body)
      if (childBodies.length === 1) {
        // 本轮结束后注销 read_file：下一轮 refresh 会把它挤出 visible，于是不进那一轮的 tools。
        // 本轮仍要发一次工具调用，否则孩子直接收尾、走不到下一轮。
        isolatedRegistry.unregister('read_file')
        return namedToolCall('keep-going', 'list_files', { path: 'src' })
      }
      if (childBodies.length === 2) {
        // 请求已发出（tools 里没有 read_file），此刻重连补回注册 —— 模拟 MCP 重连。
        isolatedRegistry.register(readFileTool)
        return namedToolCall('blind-read', 'read_file', { path: 'src/a.ts' })
      }
      if (childBodies.length === 3) {
        return namedToolCall('real-read', 'read_file', { path: 'src/a.ts' })
      }
      return response({ role: 'assistant', content: '读完了。' })
    }
    const runChildTool = vi.fn(async () => ({ ok: true as const, data: { source: 'host' } }))
    const callContext = context(new Map())
    callContext.runChildTool = runChildTool
    const delegateRuntime = createTestDelegationRuntime({
      sessionId: 'session',
      runId: 'run-subagent-autoload',
      settings: { vendor: 'deepseek', model: 'test-model' },
      registry: isolatedRegistry,
      hostHasLocalCapabilities: true,
      apiKey: 'test-key',
      signal: new AbortController().signal,
      fetchImpl,
    })

    const result = await delegateRuntime.delegateAgents({
      children: [{ objective: 'inspect', maxTurns: 6, toolProfile: 'workspace_read' }],
      toolProfile: 'workspace_read',
    }, callContext)

    const toolNamesOf = (body: Record<string, unknown>): string[] =>
      (body.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name)
    // 第 2 次请求：read_file 已被挤出 tools。
    expect(toolNamesOf(childBodies[1])).not.toContain('read_file')
    // 那一轮的盲调没有执行，只换回一次加载确认。
    const blindResult = JSON.parse(toolResultFor(childBodies[2], 'blind-read')) as Record<string, unknown>
    expect(blindResult).toMatchObject({
      loaded: true,
      toolName: 'read_file',
      code: 'tool_schema_autoloaded',
      executed: false,
    })
    expect(blindResult).not.toHaveProperty('inputSchema')
    // 第 3 次请求起 read_file 回到 tools，这一次才真执行。
    expect(toolNamesOf(childBodies[2])).toContain('read_file')
    // 总共只执行两次：第 1 轮的 list_files 与第 3 轮的 read_file。第 2 轮那次盲调没算数。
    expect(runChildTool).toHaveBeenCalledTimes(2)
    expect(runChildTool).toHaveBeenCalledWith('list_files', { path: 'src' }, expect.any(Number))
    expect(runChildTool).toHaveBeenCalledWith('read_file', { path: 'src/a.ts' }, expect.any(Number))
    expect(result.children[0].status).toBe('done')
    await delegateRuntime.dispose?.()
  })

  it('uses one injected registry for child manifest, schema loading, version snapshot, and execution', async () => {
    const isolatedRegistry = createToolRegistry()
    isolatedRegistry.register({
      name: 'read_file',
      runtime: 'server',
      skill: {
        description: 'isolated registry reader',
        content: 'ISOLATED_REGISTRY_GUIDE',
      },
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          isolatedPath: { type: 'string' },
        },
        required: ['isolatedPath'],
      },
      execute: async () => ({ ok: true, data: { source: 'isolated registry' } }),
    })
    const expectedRegistrationVersion = isolatedRegistry.registrationVersion('read_file')
    const runChildTool = vi.fn(async () => ({
      ok: true as const,
      data: { source: 'host execution' },
    }))
    let manifestResultBody: Record<string, unknown> | undefined
    let loadedRequestBody: Record<string, unknown> | undefined
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = requestBody(init)
      if (!childPath(body)) return response({ content: '# isolated skill' })
      if (!toolResultFor(body, 'isolated-manifest')) {
        return namedToolCall('isolated-manifest', 'request_tool_schema', {
          query: 'isolated',
          reason: 'discover the isolated reader',
        })
      }
      if (!toolResultFor(body, 'isolated-load')) {
        manifestResultBody = body
        return namedToolCall('isolated-load', 'request_tool_schema', {
          toolName: 'read_file',
          reason: 'load the isolated reader',
        })
      }
      if (!toolResultFor(body, 'isolated-read')) {
        loadedRequestBody = body
        return namedToolCall('isolated-read', 'read_file', {
          isolatedPath: 'src/isolated.ts',
        })
      }
      return response({ content: 'isolated read complete' })
    }
    const callContext = context(new Map())
    callContext.runChildTool = runChildTool
    const delegateRuntime = createTestDelegationRuntime({
      sessionId: 'session',
      runId: 'run-isolated-registry',
      settings: { vendor: 'deepseek', model: 'test-model' },
      registry: isolatedRegistry,
      hostHasLocalCapabilities: true,
      apiKey: 'test-key',
      signal: new AbortController().signal,
      fetchImpl,
    })

    const result = await delegateRuntime.delegateAgents({
      children: [{ objective: 'inspect isolated registry', maxTurns: 6 }],
      toolProfile: 'workspace_read',
    }, callContext)

    expect(result.children[0]).toMatchObject({
      status: 'done',
      summary: 'isolated read complete',
    })
    const manifest = JSON.parse(
      toolResultFor(manifestResultBody!, 'isolated-manifest'),
    ) as { items: unknown[] }
    expect(manifest.items).toEqual([{
      name: 'read_file',
      description: 'isolated registry reader',
      runtime: 'server',
    }])
    const exposedTools = loadedRequestBody?.tools as Array<{
      function: {
        name: string
        description: string
        parameters: Record<string, unknown>
      }
    }>
    const exposedReadFile = exposedTools.find((tool) => tool.function.name === 'read_file')
    expect(exposedReadFile?.function.description).toContain('ISOLATED_REGISTRY_GUIDE')
    expect(exposedReadFile?.function.parameters).toMatchObject({
      required: ['isolatedPath'],
      properties: { isolatedPath: { type: 'string' } },
    })
    expect(runChildTool).toHaveBeenCalledWith(
      'read_file',
      { isolatedPath: 'src/isolated.ts' },
      expectedRegistrationVersion,
    )
    delegateRuntime.dispose?.()
  })
})
