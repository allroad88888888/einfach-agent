import { describe, expect, it, vi } from 'vitest'
import { DeepSeekModelAdapter } from './deepseek-adapter'
import { MockModelAdapter } from './mock-adapter'
import { DEFAULT_DEEPSEEK_MODEL } from './index'
import { listToolSummaries, loadTool } from '../tools/registry'
import type { AgentTurnInput } from './types'

const createTurnInput = (overrides: Partial<AgentTurnInput> = {}): AgentTurnInput => ({
  userInput: '设计 web agent',
  availableTools: listToolSummaries(),
  loadedTools: [],
  loadedSkills: ['web-chat-agent'],
  artifacts: [
    {
      agentId: 'answer-worker',
      summary: 'Drafted answer.',
      proposedAnswer: 'deterministic answer',
      confidence: 0.8,
    },
  ],
  deterministicAnswer: 'deterministic answer',
  ...overrides,
})

const createSseResponse = (chunks: unknown[]) =>
  new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })

const makeAdapter = (fetchImpl: ReturnType<typeof vi.fn>) =>
  new DeepSeekModelAdapter(
    {
      provider: 'deepseek',
      apiKey: 'test-key',
      model: DEFAULT_DEEPSEEK_MODEL,
      baseUrl: 'https://api.deepseek.com',
    },
    fetchImpl as unknown as typeof fetch,
  )

const captureBody = async (input: AgentTurnInput) => {
  const fetchImpl = vi.fn().mockResolvedValue(createSseResponse([{ choices: [{ delta: { content: 'ok' } }] }]))
  await makeAdapter(fetchImpl).runAgentTurn(input)
  return JSON.parse(fetchImpl.mock.calls[0][1].body)
}

describe('§1.8 regression red line — empty conversationContext is byte-equivalent to current', () => {
  it('omitting conversationContext entirely produces identical request body', async () => {
    const baseline = await captureBody(createTurnInput({ userInput: '随便优化一下' }))

    const withEmpty = await captureBody(
      createTurnInput({
        userInput: '随便优化一下',
        conversationContext: { recentMessages: [] },
      }),
    )

    expect(JSON.stringify(withEmpty)).toBe(JSON.stringify(baseline))
  })

  it('conversationContext with empty summary and no recentMessages is byte-equivalent', async () => {
    const baseline = await captureBody(createTurnInput({ userInput: '随便优化一下' }))

    const withEmpty = await captureBody(
      createTurnInput({
        userInput: '随便优化一下',
        conversationContext: { summary: '', recentMessages: [] },
      }),
    )

    expect(JSON.stringify(withEmpty)).toBe(JSON.stringify(baseline))
    // system text must be byte-identical (no "不确定就 ask" / summary injection)
    expect(withEmpty.messages[0].content).toBe(baseline.messages[0].content)
    expect(withEmpty.messages[0].content).not.toContain('先前对话摘要')
    // still exactly system + user (no extra history messages)
    expect(withEmpty.messages).toHaveLength(2)
    expect(withEmpty.messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user'])
  })
})

describe('M1.4 buildAgentTurnMessages injects history first turn', () => {
  it('expands recentMessages as [user, assistant, ...] between system and current user', async () => {
    const body = await captureBody(
      createTurnInput({
        userInput: '继续上面的话题',
        conversationContext: {
          recentMessages: [
            { role: 'user', content: '第一句问题' },
            { role: 'assistant', content: '第一句回答' },
            { role: 'user', content: '第二句问题' },
            { role: 'assistant', content: '第二句回答' },
          ],
        },
      }),
    )

    expect(body.messages.map((m: { role: string }) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
    ])
    // history messages carry the raw content verbatim
    expect(body.messages[1].content).toBe('第一句问题')
    expect(body.messages[2].content).toBe('第一句回答')
    expect(body.messages[3].content).toBe('第二句问题')
    expect(body.messages[4].content).toBe('第二句回答')
    // the LAST user message is the current-run user input (with worker signals)
    expect(body.messages.at(-1).content).toContain('用户输入：继续上面的话题')
    expect(body.messages.at(-1).content).toContain('worker signals')
  })

  it('appends 先前对话摘要 to system only when summary is non-empty', async () => {
    const baseline = await captureBody(createTurnInput({ userInput: '随便优化一下' }))

    const withSummary = await captureBody(
      createTurnInput({
        userInput: '随便优化一下',
        conversationContext: {
          summary: '用户偏好简洁回答。',
          recentMessages: [{ role: 'user', content: '历史一句' }],
        },
      }),
    )

    expect(withSummary.messages[0].content).toContain('先前对话摘要')
    expect(withSummary.messages[0].content).toContain('用户偏好简洁回答。')
    // the baseline (original) system text must remain a prefix — original instructions intact
    expect(withSummary.messages[0].content.startsWith(baseline.messages[0].content)).toBe(true)
  })
})

describe('Rm9 continuation second turn does not re-inject history', () => {
  it('continuation branch ignores conversationContext (history already in state.messages)', async () => {
    const askUserTool = loadTool('ask_user_question')
    const body = await captureBody({
      ...createTurnInput({ userInput: '随便优化一下' }),
      loadedTools: askUserTool ? [askUserTool] : [],
      conversationContext: {
        recentMessages: [
          { role: 'user', content: '历史问题不应再次出现' },
          { role: 'assistant', content: '历史回答不应再次出现' },
        ],
      },
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
                    arguments: JSON.stringify({ toolName: 'ask_user_question', reason: 'Need user decisions.' }),
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
        content: JSON.stringify({ toolName: 'ask_user_question', inputSchema: askUserTool?.inputSchema }),
      },
    })

    const serialized = JSON.stringify(body.messages)
    expect(serialized).not.toContain('历史问题不应再次出现')
    expect(serialized).not.toContain('历史回答不应再次出现')
    // continuation body = state.messages (3) + one tool result = 4
    expect(body.messages).toHaveLength(4)
    expect(body.messages.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call-schema-1' })
  })
})

describe('M1.5 mock adapter exposes conversationContext', () => {
  it('records the conversationContext seen on each runAgentTurn call', async () => {
    const adapter = new MockModelAdapter()
    const context = {
      recentMessages: [{ role: 'user' as const, content: '历史一句' }],
    }

    await adapter.runAgentTurn(createTurnInput({ userInput: 'hi', conversationContext: context }))

    expect(adapter.lastConversationContext).toEqual(context)
    expect(adapter.conversationContexts).toHaveLength(1)
    expect(adapter.conversationContexts[0]).toEqual(context)
  })
})
