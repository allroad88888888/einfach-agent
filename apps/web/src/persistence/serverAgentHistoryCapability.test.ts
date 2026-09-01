import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostInvoke } from '@einfach-agent/core'
import { AgentHistoryError, type AgentHistoryErrorCode } from '@einfach-agent/core/history'
import type { ToolContext } from '@einfach-agent/core/tools'
import { listAgentHistoriesTool } from '../../../../tools/agents/src/list-agent-histories/list-agent-histories'
import { mapInvokeRouteError } from '../../../server/src/invokeRouteError'
import { ServerInvokeError } from '../host/serverInvoke'
import { createServerAgentHistoryCapability } from './serverAgentHistoryCapability'

afterEach(() => vi.unstubAllGlobals())

function historyContext(): ToolContext {
  return {
    agentHistory: createServerAgentHistoryCapability().forContext({ legacyWorkspaceRoot: '/workspace' }),
  } as ToolContext
}

function stubServerFailure(error: unknown): void {
  const mapped = mapInvokeRouteError(error)
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: false,
    status: mapped.statusCode,
    json: async () => ({ error: mapped.error, message: mapped.message }),
  })))
}

describe('server agent history capability', () => {
  it('passes each structured result through its command envelope', async () => {
    const results = [
      { histories: [], nextCursor: 'history-next', warnings: [{ code: 'PROJECTION_LAG', message: 'lag' }] },
      { history: { historyId: 'h' }, items: [], nextCursor: 'item-next', warnings: [] },
      { item: { itemId: 'i' }, text: 'body', offset: 0, totalChars: 4, warnings: [] },
      { hits: [], nextCursor: 'search-next', warnings: [{ code: 'SEARCH_INDEX_LAG', message: 'lag' }] },
    ]
    const invokeMock = vi.fn()
    results.forEach((result) => invokeMock.mockResolvedValueOnce(result))
    const capability = createServerAgentHistoryCapability(invokeMock as HostInvoke)
      .forContext({ legacyWorkspaceRoot: '/workspace' })
    const target = { kind: 'root' as const, conversationId: 'conversation' }
    const inputs = [
      {},
      { target },
      { target, itemId: 'item' },
      { query: 'needle', target },
    ] as const

    const actual = await Promise.all([
      capability.listHistories(inputs[0]),
      capability.listItems(inputs[1]),
      capability.readItem(inputs[2]),
      capability.search(inputs[3]),
    ])

    expect(actual).toEqual(results)
    expect(invokeMock.mock.calls).toEqual([
      ['agent_history_list', { input: inputs[0], legacyWorkspaceRoot: '/workspace' }],
      ['agent_history_list_items', { input: inputs[1], legacyWorkspaceRoot: '/workspace' }],
      ['agent_history_read_item', { input: inputs[2], legacyWorkspaceRoot: '/workspace' }],
      ['agent_history_search', { input: inputs[3], legacyWorkspaceRoot: '/workspace' }],
    ])
  })

  it('does not expose a legacy path when the context has none', async () => {
    const invokeMock = vi.fn(async () => ({ histories: [], warnings: [] }))
    await createServerAgentHistoryCapability(invokeMock as HostInvoke)
      .forContext({}).listHistories({})
    expect(invokeMock).toHaveBeenCalledWith('agent_history_list', { input: {} })
  })

  it('uses the structured server transport by default without changing success envelopes', async () => {
    const result = { histories: [], nextCursor: 'next', warnings: [{ code: 'PROJECTION_LAG', message: 'lag' }] }
    let requestBody = ''
    const fetchMock = vi.fn(async (_input: string, init: { body: string }) => {
      requestBody = init.body
      return { ok: true, status: 200, json: async () => result }
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(createServerAgentHistoryCapability().forContext({ legacyWorkspaceRoot: '/workspace' })
      .listHistories({ limit: 2 })).resolves.toBe(result)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(JSON.parse(requestBody)).toEqual({
      input: { limit: 2 }, legacyWorkspaceRoot: '/workspace',
    })
  })

  it.each([
    'AGENT_HISTORY_INVALID_CURSOR',
    'AGENT_HISTORY_SOURCE_CORRUPT',
  ] as const)('preserves %s through mapper, Web adapter, and tool execute', async (code) => {
    stubServerFailure(new AgentHistoryError(code, 'history failed'))

    await expect(listAgentHistoriesTool.execute({}, historyContext())).resolves.toMatchObject({
      ok: false,
      code,
      retryable: false,
      error: 'history failed',
    })
  })

  it('keeps an unknown command failure generic and retryable at tool execute', async () => {
    stubServerFailure({ code: 'AGENT_HISTORY_FUTURE_CODE', message: 'future failure' })

    await expect(listAgentHistoriesTool.execute({}, historyContext())).resolves.toMatchObject({
      ok: false,
      code: 'AGENT_HISTORY_QUERY_FAILED',
      retryable: true,
      error: expect.stringContaining('future failure'),
    })
  })

  it('applies the same typed mapping to the injected HostInvoke seam', async () => {
    const code: AgentHistoryErrorCode = 'AGENT_HISTORY_ITEM_DELETED'
    const invokeMock = vi.fn(async () => {
      throw new ServerInvokeError({ status: 502, code, message: 'deleted' })
    })

    await expect(createServerAgentHistoryCapability(invokeMock as HostInvoke)
      .forContext({}).listHistories({})).rejects.toMatchObject({
      name: 'AgentHistoryError', code, message: 'deleted',
    })
  })
})
