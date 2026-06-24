import { describe, expect, it, vi } from 'vitest'
import { createModelAdapter, DEFAULT_DEEPSEEK_MODEL, getModelConfig } from './index'
import { DeepSeekModelAdapter } from './deepseek-adapter'
import { MockModelAdapter } from './mock-adapter'
import { listToolSummaries, loadTool } from '../tools/registry'
import type { AgentTurnInput, GenerateFinalAnswerInput } from './types'

const input: GenerateFinalAnswerInput = {
  userInput: '设计 web agent',
  loadedSkills: ['web-chat-agent'],
  loadedTools: ['delegate_agent', 'skill_read'],
  artifacts: [
    {
      agentId: 'answer-worker',
      summary: 'Drafted answer.',
      proposedAnswer: 'deterministic answer',
      confidence: 0.8,
    },
  ],
  deterministicAnswer: 'deterministic answer',
}

const createTurnInput = (overrides: Partial<AgentTurnInput> = {}): AgentTurnInput => ({
  userInput: '设计 web agent',
  availableTools: listToolSummaries(),
  loadedTools: [],
  loadedSkills: ['web-chat-agent'],
  artifacts: input.artifacts,
  deterministicAnswer: 'deterministic answer',
  ...overrides,
})

const createSseResponse = (chunks: unknown[]) =>
  new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
    },
  })

describe('model adapter config', () => {
  it('defaults to mock without an API key', () => {
    const config = getModelConfig({})

    expect(config).toMatchObject({
      provider: 'mock',
      apiKey: '',
      model: DEFAULT_DEEPSEEK_MODEL,
      baseUrl: 'https://api.deepseek.com',
    })
    expect(createModelAdapter(config).kind).toBe('mock')
  })

  it('switches to DeepSeek when a key is present', () => {
    const config = getModelConfig({
      VITE_DEEPSEEK_API_KEY: 'test-key',
    })

    expect(config.provider).toBe('deepseek')
    expect(config.model).toBe(DEFAULT_DEEPSEEK_MODEL)
    expect(createModelAdapter(config).kind).toBe('deepseek')
  })

  it('allows explicit provider, model, and base URL overrides', () => {
    const config = getModelConfig({
      VITE_AGENT_MODEL_PROVIDER: 'deepseek',
      VITE_DEEPSEEK_API_KEY: 'test-key',
      VITE_DEEPSEEK_MODEL: 'deepseek-v4-flash',
      VITE_DEEPSEEK_BASE_URL: 'https://example.test',
    })

    expect(config).toMatchObject({
      provider: 'deepseek',
      apiKey: 'test-key',
      model: 'deepseek-v4-flash',
      baseUrl: 'https://example.test',
    })
  })
})

describe('DeepSeekModelAdapter', () => {
  it('falls back without calling fetch when the key is missing', async () => {
    const fetchImpl = vi.fn()
    const adapter = new DeepSeekModelAdapter(
      {
        provider: 'deepseek',
        apiKey: '',
        model: DEFAULT_DEEPSEEK_MODEL,
        baseUrl: 'https://api.deepseek.com',
      },
      fetchImpl,
    )

    await expect(adapter.generateFinalAnswer(input)).resolves.toMatchObject({
      source: 'fallback',
      content: 'deterministic answer',
      error: expect.stringContaining('VITE_DEEPSEEK_API_KEY'),
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('calls the DeepSeek OpenAI-compatible chat completions API', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      createSseResponse([
        { choices: [{ delta: { reasoning_content: 'Thinking.' } }] },
        { choices: [{ delta: { content: 'deepseek ' } }] },
        { choices: [{ delta: { content: 'answer' } }] },
      ]),
    )
    const adapter = new DeepSeekModelAdapter(
      {
        provider: 'deepseek',
        apiKey: 'test-key',
        model: DEFAULT_DEEPSEEK_MODEL,
        baseUrl: 'https://api.deepseek.com',
      },
      fetchImpl,
    )

    await expect(adapter.generateFinalAnswer(input)).resolves.toEqual({
      source: 'deepseek',
      content: 'deepseek answer',
    })

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.deepseek.com/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-key',
          'Content-Type': 'application/json',
        }),
      }),
    )

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body)
    expect(body).toMatchObject({
      model: DEFAULT_DEEPSEEK_MODEL,
      stream: true,
      thinking: {
        type: 'enabled',
      },
      reasoning_effort: 'high',
    })
    expect(body.messages.at(-1).content).toContain('deterministic answer')
    expect(body.messages[0].content).toContain('最终回答生成器')
    expect(body.messages[0].content).toContain('不要暴露内部调度角色')
    expect(body.messages[0].content).not.toContain('DeputyArchitectAgent')
  })

  it('runs the first agent turn with a tool manifest and parses a schema-request tool call', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      createSseResponse([
        { choices: [{ delta: { reasoning_content: 'Need ask_user_question schema.' } }] },
        { choices: [{ delta: { content: 'I need to ask a question.' } }] },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call-schema-1',
                    type: 'function',
                    function: {
                      name: 'request_tool_schema',
                      arguments: '{"toolName":"ask_user_question",',
                    },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: {
                      arguments: '"reason":"Need user decisions."}',
                    },
                  },
                ],
              },
            },
          ],
        },
      ]),
    )
    const adapter = new DeepSeekModelAdapter(
      {
        provider: 'deepseek',
        apiKey: 'test-key',
        model: DEFAULT_DEEPSEEK_MODEL,
        baseUrl: 'https://api.deepseek.com',
      },
      fetchImpl,
    )
    const streamEvents: unknown[] = []

    await expect(
      adapter.runAgentTurn(
        createTurnInput({
          userInput: '随便优化一下',
          onStreamEvent: (event) => streamEvents.push(event),
        }),
      ),
    ).resolves.toMatchObject({
      type: 'tool_request',
      toolName: 'ask_user_question',
      reason: 'Need user decisions.',
      continuation: {
        provider: 'deepseek',
      },
    })
    expect(streamEvents).toEqual(
      expect.arrayContaining([
        { type: 'reasoning', content: 'Need ask_user_question schema.' },
        { type: 'content', content: 'I need to ask a question.' },
        expect.objectContaining({
          type: 'tool_call',
          name: 'request_tool_schema',
          argumentsDelta: '{"toolName":"ask_user_question",',
        }),
        expect.objectContaining({
          type: 'tool_call',
          name: 'request_tool_schema',
          argumentsDelta: '"reason":"Need user decisions."}',
        }),
      ]),
    )

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body)
    expect(body).toMatchObject({
      model: DEFAULT_DEEPSEEK_MODEL,
      thinking: {
        type: 'enabled',
      },
      temperature: 0,
      reasoning_effort: 'high',
      tool_choice: 'auto',
      stream: true,
    })
    expect(body).not.toHaveProperty('response_format')
    expect(body.messages[0].content).toContain('可以像普通 assistant 一样直接回复用户')
    expect(body.messages[0].content).toContain('只有 API tools 字段中暴露的 function 可以直接调用')
    expect(body.messages[0].content).toContain('如果当前任务需要某个工具能力')
    expect(body.messages[0].content).toContain('调用 request_tool_schema 选择工具名并说明原因')
    expect(body.messages[0].content).toContain('结构化收集输入')
    expect(body.messages[0].content).toContain('选择工具清单中匹配的能力')
    expect(body.messages[0].content).toContain('当用户要求你提问、确认、收集答案、等待选择')
    expect(body.messages[0].content).toContain('如果用户已经补充答案，本轮必须优先基于这些答案继续执行')
    expect(body.messages[0].content).toContain('不要因为原始用户输入里包含“问我”或“确认”而再次暂停')
    expect(body.messages[0].content).toContain('普通 assistant 文本不会改变 runtime 状态')
    expect(body.messages[0].content).not.toContain('你必须通过 ask_user_question 暂停运行')
    expect(body.messages[0].content).not.toContain('唯一正确动作是调用 request_tool_schema')
    expect(body.messages[0].content).not.toContain('不要把需要用户回答的问题写成普通 assistant 文本')
    expect(body.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual(['request_tool_schema'])
    expect(body.tools[0].function.parameters.properties.toolName.enum).toEqual([
      'ask_user_question',
      'skill_search',
      'skill_read',
      'delegate_agent',
      'browser_action',
    ])
    expect(body.messages[1].content).toContain('工具清单（仅摘要，schema 未加载）：')
    expect(body.messages[1].content).toContain('"name":"ask_user_question"')
    expect(body.messages[1].content).toContain('"description":"暂停当前 run，向用户提出一个或多个结构化问题并收集缺失决策。"')
    expect(body.messages[1].content).toContain('已加载工具：none')
    expect(body.messages[1].content).toContain('已加载工具 schema 名称：none')
    expect(body.messages[1].content).toContain('worker signals：')
    expect(body.messages[1].content).not.toContain('proposedAnswer')
    expect(body.messages[1].content).not.toContain('确定性 fallback')
    expect(body.messages[1].content).not.toContain('deterministic answer')
    expect(body.messages[1].content).not.toContain('"inputSchema"')
  })

  it('parses batched schema requests and responds to every pending tool call', async () => {
    const firstFetch = vi.fn().mockResolvedValue(
      createSseResponse([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call-search',
                    type: 'function',
                    function: {
                      name: 'request_tool_schema',
                      arguments: '{"toolName":"skill_search","reason":"Need search schema."}',
                    },
                  },
                  {
                    index: 1,
                    id: 'call-read',
                    type: 'function',
                    function: {
                      name: 'request_tool_schema',
                      arguments: '{"toolName":"skill_read","reason":"Need read schema."}',
                    },
                  },
                ],
              },
            },
          ],
        },
      ]),
    )
    const firstAdapter = new DeepSeekModelAdapter(
      {
        provider: 'deepseek',
        apiKey: 'test-key',
        model: DEFAULT_DEEPSEEK_MODEL,
        baseUrl: 'https://api.deepseek.com',
      },
      firstFetch,
    )

    const decision = await firstAdapter.runAgentTurn(createTurnInput({ userInput: '推荐 skills' }))
    expect(decision).toMatchObject({
      type: 'tool_requests',
      requests: [
        { toolName: 'skill_search', toolCallId: 'call-search' },
        { toolName: 'skill_read', toolCallId: 'call-read' },
      ],
    })

    const secondFetch = vi.fn().mockResolvedValue(createSseResponse([{ choices: [{ delta: { content: 'done' } }] }]))
    const secondAdapter = new DeepSeekModelAdapter(
      {
        provider: 'deepseek',
        apiKey: 'test-key',
        model: DEFAULT_DEEPSEEK_MODEL,
        baseUrl: 'https://api.deepseek.com',
      },
      secondFetch,
    )

    const skillSearchTool = loadTool('skill_search')
    const skillReadTool = loadTool('skill_read')
    await secondAdapter.runAgentTurn({
      ...createTurnInput({ userInput: '推荐 skills' }),
      loadedTools: [skillSearchTool, skillReadTool].filter(Boolean) as NonNullable<typeof skillSearchTool>[],
      continuation: decision.type === 'tool_requests' ? decision.continuation : undefined,
      toolResults: [
        {
          toolName: 'skill_search',
          toolCallId: 'call-search',
          content: JSON.stringify({ toolName: 'skill_search', inputSchema: skillSearchTool?.inputSchema }),
        },
        {
          toolName: 'skill_read',
          toolCallId: 'call-read',
          content: JSON.stringify({ toolName: 'skill_read', inputSchema: skillReadTool?.inputSchema }),
        },
      ],
    })

    const body = JSON.parse(secondFetch.mock.calls[0][1].body)
    expect(body.messages.slice(-2)).toEqual([
      expect.objectContaining({ role: 'tool', tool_call_id: 'call-search' }),
      expect.objectContaining({ role: 'tool', tool_call_id: 'call-read' }),
    ])
  })

  it('includes loaded tool JSON schema only after schema loading', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      createSseResponse([
        { choices: [{ delta: { reasoning_content: 'Ask the user.' } }] },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call-ask-1',
                    type: 'function',
                    function: {
                      name: 'ask_user_question',
                      arguments: '{"id":"question-test",',
                    },
                  },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: {
                      arguments: '"questions":[{"id":"scope","text":"scope?","type":"text"}]}',
                    },
                  },
                ],
              },
            },
          ],
        },
      ]),
    )
    const adapter = new DeepSeekModelAdapter(
      {
        provider: 'deepseek',
        apiKey: 'test-key',
        model: DEFAULT_DEEPSEEK_MODEL,
        baseUrl: 'https://api.deepseek.com',
      },
      fetchImpl,
    )
    const askUserTool = loadTool('ask_user_question')

    await adapter.runAgentTurn({
      ...createTurnInput({ userInput: '随便优化一下' }),
      loadedTools: askUserTool ? [askUserTool] : [],
      continuation: {
        provider: 'deepseek',
        state: {
          messages: [
            { role: 'system', content: 'system' },
            { role: 'user', content: 'user' },
            {
              role: 'assistant',
              content: '',
              reasoning_content: 'Need ask_user_question schema.',
              tool_calls: [
                {
                  id: 'call-schema-1',
                  type: 'function',
                  function: {
                    name: 'request_tool_schema',
                    arguments: JSON.stringify({
                      toolName: 'ask_user_question',
                      reason: 'Need user decisions.',
                    }),
                  },
                },
              ],
            },
          ],
          pendingToolCallId: 'call-schema-1',
          pendingToolName: 'request_tool_schema',
        },
      },
      toolResult: {
        toolName: 'ask_user_question',
        content: JSON.stringify({
          toolName: 'ask_user_question',
          inputSchema: askUserTool?.inputSchema,
        }),
      },
    })

    const body = JSON.parse(fetchImpl.mock.calls[0][1].body)
    expect(body.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual([
      'request_tool_schema',
      'ask_user_question',
    ])
    expect(body.messages.at(-2)).toMatchObject({
      role: 'assistant',
      reasoning_content: 'Need ask_user_question schema.',
    })
    expect(body.messages.at(-1)).toMatchObject({
      role: 'tool',
      tool_call_id: 'call-schema-1',
    })
    expect(body.messages.at(-1).content).toContain('"toolName":"ask_user_question"')
    expect(body.messages.at(-1).content).toContain('"inputSchema"')
    expect(body.messages.at(-1).content).toContain('"questions"')
    expect(body.tools[1].function.parameters).toMatchObject({
      type: 'object',
      properties: {
        questions: expect.any(Object),
      },
    })
  })

  it('treats non-JSON output as a normal assistant message', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      createSseResponse([
        { choices: [{ delta: { content: 'not ' } }] },
        { choices: [{ delta: { content: 'json' } }] },
      ]),
    )
    const adapter = new DeepSeekModelAdapter(
      {
        provider: 'deepseek',
        apiKey: 'test-key',
        model: DEFAULT_DEEPSEEK_MODEL,
        baseUrl: 'https://api.deepseek.com',
      },
      fetchImpl,
    )

    await expect(
      adapter.runAgentTurn(createTurnInput({ userInput: '随便优化一下' })),
    ).resolves.toEqual({
      type: 'assistant_message',
      source: 'deepseek',
      content: 'not json',
    })
  })

  it('falls back when DeepSeek returns unsupported agent-turn JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      createSseResponse([
        {
          choices: [
            {
              delta: {
                content: JSON.stringify({
                  type: 'unsupported',
                  reason: 'unsupported protocol',
                }),
              },
            },
          ],
        },
      ]),
    )
    const adapter = new DeepSeekModelAdapter(
      {
        provider: 'deepseek',
        apiKey: 'test-key',
        model: DEFAULT_DEEPSEEK_MODEL,
        baseUrl: 'https://api.deepseek.com',
      },
      fetchImpl,
    )

    await expect(
      adapter.runAgentTurn(createTurnInput({ userInput: 'hi', deterministicAnswer: 'Hi fallback' })),
    ).resolves.toMatchObject({
      type: 'assistant_message',
      source: 'fallback',
      content: 'Hi fallback',
      error: 'Model returned unsupported agent-turn JSON.',
    })
  })

  it('falls back when DeepSeek returns an empty answer or an error response', async () => {
    const emptyFetch = vi.fn().mockResolvedValue(createSseResponse([]))
    const emptyAdapter = new DeepSeekModelAdapter(
      {
        provider: 'deepseek',
        apiKey: 'test-key',
        model: DEFAULT_DEEPSEEK_MODEL,
        baseUrl: 'https://api.deepseek.com',
      },
      emptyFetch,
    )

    await expect(emptyAdapter.generateFinalAnswer(input)).resolves.toMatchObject({
      source: 'fallback',
      content: 'deterministic answer',
      error: expect.stringContaining('empty'),
    })

    const errorFetch = vi.fn().mockResolvedValue(new Response('unauthorized', { status: 401 }))
    const errorAdapter = new DeepSeekModelAdapter(
      {
        provider: 'deepseek',
        apiKey: 'test-key',
        model: DEFAULT_DEEPSEEK_MODEL,
        baseUrl: 'https://api.deepseek.com',
      },
      errorFetch,
    )

    await expect(errorAdapter.generateFinalAnswer(input)).resolves.toMatchObject({
      source: 'fallback',
      content: 'deterministic answer',
      error: expect.stringContaining('401'),
    })
  })
})

describe('MockModelAdapter tool negotiation protocol', () => {
  it('does not request AskUserQuestion for a greeting', async () => {
    const adapter = new MockModelAdapter()

    await expect(
      adapter.runAgentTurn(createTurnInput({ userInput: 'hi', deterministicAnswer: 'Hi fallback' })),
    ).resolves.toEqual({
      type: 'assistant_message',
      source: 'mock',
      content: 'Hi fallback',
    })
  })

  it('requests ask_user_question before the schema is loaded', async () => {
    const adapter = new MockModelAdapter()

    await expect(
      adapter.runAgentTurn(createTurnInput({ userInput: '随便优化一下' })),
    ).resolves.toEqual({
      type: 'tool_request',
      toolName: 'ask_user_question',
      reason: 'The request is ambiguous and needs user decisions.',
    })
  })

  it('returns the ask_user_question payload only after the schema is loaded', async () => {
    const adapter = new MockModelAdapter()
    const askUserTool = loadTool('ask_user_question')

    await expect(
      adapter.runAgentTurn({
        ...createTurnInput({ userInput: '随便优化一下' }),
        loadedTools: askUserTool ? [askUserTool] : [],
      }),
    ).resolves.toMatchObject({
      type: 'tool_payload',
      toolName: 'ask_user_question',
      payload: {
        title: '需要确认',
        questions: [
          { id: 'execution_scope', type: 'single-choice', required: true },
          { id: 'extra_context', type: 'text' },
          { id: 'focus_modules', type: 'multi-choice', required: true },
          { id: 'allow_assumptions', type: 'confirm', required: true },
        ],
      },
    })
  })
})
