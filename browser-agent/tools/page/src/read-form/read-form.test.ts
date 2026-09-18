import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '@einfach-agent/core/tools'
import { createReadFormTool } from './read-form'
import type { PageToolsHost } from '../types'
describe('read_form tool', () => {
  it('calls only the injected host with trusted context', async () => {
    const snapshot = { page: { targetId: 't', documentId: 'd', revision: 1 }, fields: [] }
    const readForm = vi.fn(async () => snapshot); const host = { readForm } as unknown as PageToolsHost
    const ctx = { sessionId: 's', signal: new AbortController().signal } as ToolContext
    expect(await createReadFormTool(host).execute({}, ctx)).toEqual({ ok: true, data: snapshot })
    expect(readForm).toHaveBeenCalledWith(ctx); expect(createReadFormTool(host).inputSchema).toMatchObject({ additionalProperties: false })
  })
})
