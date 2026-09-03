import { describe, expect, it, vi } from 'vitest'
import { AGENT_HISTORY_QUERY_TARGET_MAX_CHARS,
  type AgentHistoryCapabilityProvider } from '@einfach-agent/core/history'
import { createHistoryRoutes } from './historyCommands'

function fixture() {
  const capability = { listHistories: vi.fn(async () => ({ histories: [], warnings: [] })),
    listItems: vi.fn(), readItem: vi.fn(), search: vi.fn() }
  const provider = { forContext: vi.fn(() => capability) } as unknown as AgentHistoryCapabilityProvider
  return { routes: createHistoryRoutes(provider), provider, capability }
}

describe('history commands', () => {
  it('narrows a valid envelope before dispatch', async () => {
    const { routes, provider, capability } = fixture()
    await routes.agent_history_list!({ input: { target: { kind: 'root', conversationId: 'c' }, limit: 2 },
      legacyWorkspaceRoot: '/workspace' })
    expect(provider.forContext).toHaveBeenCalledWith({ legacyWorkspaceRoot: '/workspace' })
    expect(capability.listHistories).toHaveBeenCalledWith({ target: { kind: 'root', conversationId: 'c' }, limit: 2 })
  })

  it.each([
    { input: {}, extra: true },
    { input: { target: { kind: 'root', conversationId: 'c', path: '/secret' } } },
    { input: { target: { kind: 'root',
      conversationId: 'c'.repeat(AGENT_HISTORY_QUERY_TARGET_MAX_CHARS + 1) } } },
    { input: { limit: 101 } },
  ])('rejects unknown, target and limit input before provider I/O', async (args) => {
    const { routes, provider } = fixture()
    await expect(routes.agent_history_list!(args)).rejects.toThrow()
    expect(provider.forContext).not.toHaveBeenCalled()
  })

  it('trims query before code-point validation and dispatch', async () => {
    const { routes, capability } = fixture()
    capability.search.mockResolvedValue({ hits: [], warnings: [] })
    await routes.agent_history_search!({ input: { query: '  needle  ' } })
    expect(capability.search).toHaveBeenCalledWith({ query: 'needle' })
  })

  it('rejects whitespace query before provider I/O', async () => {
    const { routes, provider } = fixture()
    await expect(routes.agent_history_search!({ input: { query: '   ' } })).rejects.toThrow('query')
    expect(provider.forContext).not.toHaveBeenCalled()
  })

  it('reads offset once before provider dispatch', async () => {
    const { routes, capability } = fixture(); let reads = 0
    capability.readItem.mockResolvedValue({})
    const input: Record<string, unknown> = { target: { kind: 'root', conversationId: 'c' }, itemId: 'i' }
    Object.defineProperty(input, 'offset', { enumerable: true, get() { reads += 1; return 3 } })
    await routes.agent_history_read_item!({ input })
    expect(reads).toBe(1)
    expect(capability.readItem).toHaveBeenCalledWith({ target: { kind: 'root', conversationId: 'c' }, itemId: 'i', offset: 3 })
  })
})
