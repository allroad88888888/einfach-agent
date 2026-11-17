import { describe, expect, it, vi } from 'vitest'
import { createToolRegistry, type ToolContext } from '@einfach-agent/core/tools'
import { deepseekSearchTool } from './deepseek-search'

function context(): ToolContext {
  return {
    sessionId: 'search-test', signal: new AbortController().signal,
    progress: vi.fn(), callTool: vi.fn(), runShell: vi.fn(),
    renderCard: vi.fn(), saveArtifact: vi.fn(),
    webSearch: vi.fn(async () => ({ ok: true as const, data: { results: [] } })),
  }
}

describe('deepseek_search', () => {
  it('registers a discoverable tool and supplies API defaults', async () => {
    const registry = createToolRegistry()
    registry.register(deepseekSearchTool)
    const ctx = context()
    const query = 'DeepSeek site:github.com lang:zh after:2026-01-01'
    expect(registry.list().map((tool) => tool.name)).toContain('deepseek_search')
    await expect(registry.run('deepseek_search', { query }, ctx))
      .resolves.toEqual({ ok: true, data: { results: [] } })
    expect(ctx.webSearch).toHaveBeenCalledWith({ query, count: 10, need_content: false })
  })

  it('forwards search options without rewriting search syntax', async () => {
    const ctx = context()
    const input = {
      query: '"精确短语" -广告', count: 3, ori_question: '用户原始问题',
      localization: '1.1.1.1', need_content: true,
    }
    await deepseekSearchTool.execute(input, ctx)
    expect(ctx.webSearch).toHaveBeenCalledWith(input)
  })

  it('accepts 128 Unicode code points and nullable original questions through the registry', async () => {
    const registry = createToolRegistry()
    registry.register(deepseekSearchTool)
    const ctx = context()
    const query = '😀'.repeat(128)
    await expect(registry.run('deepseek_search', { query, ori_question: null }, ctx))
      .resolves.toMatchObject({ ok: true })
    expect(ctx.webSearch).toHaveBeenCalledWith({ query, count: 10, need_content: false })
  })

  it.each([
    null, [], {}, { query: ' ' }, { query: 'a'.repeat(129) },
    { query: 'x', count: 0 }, { query: 'x', count: 51 }, { query: 'x', count: 1.5 },
    { query: 'x', ori_question: ' ' }, { query: 'x', ori_question: '😀'.repeat(129) },
    { query: 'x', need_content: 'true' }, { query: 'x', localization: 42 },
    { query: 'x', apiKey: 'secret' },
  ])('rejects invalid input before invoking the host: %j', async (input) => {
    const ctx = context()
    await expect(deepseekSearchTool.execute(input, ctx))
      .resolves.toMatchObject({ ok: false, code: 'DEEPSEEK_SEARCH_INVALID_INPUT', retryable: false })
    expect(ctx.webSearch).not.toHaveBeenCalled()
  })

  it('handles absent capabilities, cancellation and private host errors', async () => {
    const ctx = context()
    delete ctx.webSearch
    await expect(deepseekSearchTool.execute({ query: 'x' }, ctx))
      .resolves.toMatchObject({ code: 'DEEPSEEK_SEARCH_UNAVAILABLE' })
    ctx.webSearch = vi.fn(async () => { throw new Error('private-key') })
    const failed = await deepseekSearchTool.execute({ query: 'x' }, ctx)
    expect(JSON.stringify(failed)).not.toContain('private-key')
    expect(failed).toMatchObject({ ok: false, retryable: true })
    const aborted = { ...ctx, signal: AbortSignal.abort() }
    await expect(deepseekSearchTool.execute({ query: 'x' }, aborted))
      .resolves.toMatchObject({ code: 'DEEPSEEK_SEARCH_ABORTED', retryable: false })
    expect(ctx.webSearch).toHaveBeenCalledTimes(1)
  })
})
