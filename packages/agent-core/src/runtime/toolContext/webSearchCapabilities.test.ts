import { describe, expect, it, vi } from 'vitest'
import { createCoreInstance } from '../core/coreInstance'
import { buildToolContext } from '../toolContext'
import { seedSession } from '../toolContext.workspaceRoot.testHarness'
import type { ToolResult } from '../../tools/types'
import type { WebSearchCapability } from '../../tools/webSearch'

function setup(webSearch?: WebSearchCapability) {
  const core = createCoreInstance({ config: { webSearch } })
  seedSession('search', '/workspace', 'confirm', core)
  const controller = new AbortController()
  const ctx = (runId = 'r') => buildToolContext({
    sessionId: 'search', runId, signal: controller.signal,
    callId: 'search-call', toolName: 'search', core,
  })
  return { ctx, controller }
}

describe('web search capability', () => {
  it('omits the capability when the app has not supplied it', () => {
    expect(setup().ctx().webSearch).toBeUndefined()
  })

  it('passes only the input and cancellation signal to the app port', async () => {
    const webSearch = vi.fn(async (): Promise<ToolResult> => ({ ok: true, data: { results: [] } }))
    const { ctx, controller } = setup(webSearch)
    await expect(ctx().webSearch!({ query: 'example' })).resolves.toMatchObject({ ok: true })
    expect(webSearch).toHaveBeenCalledWith({ query: 'example' }, { signal: controller.signal })
  })

  it('blocks stale calls and discards results that arrive after cancellation', async () => {
    let finish!: (result: ToolResult) => void
    const webSearch = vi.fn(() => new Promise<ToolResult>((resolve) => { finish = resolve }))
    const { ctx, controller } = setup(webSearch)
    await expect(ctx('old').webSearch!({ query: 'x' })).rejects.toThrow('stale')
    expect(webSearch).not.toHaveBeenCalled()
    const pending = ctx().webSearch!({ query: 'x' })
    controller.abort()
    finish({ ok: true, data: { results: [] } })
    await expect(pending).rejects.toThrow('stale')
  })
})
