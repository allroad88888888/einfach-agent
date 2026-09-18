import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '@einfach-agent/core/tools'
import { createFillFieldsTool } from './fill-fields'
import type { PageToolsHost } from '../types'
describe('fill_fields tool', () => {
  it('forwards page and values, preserves per-field outcomes, and declares unsafe serial writes', async () => {
    const fields = [{ id: 'a', ok: true, value: 'x' as const }, { id: 'b', ok: false, error: 'missing' }]
    const fillFields = vi.fn(async () => fields); const host = { fillFields } as unknown as PageToolsHost
    const ctx = { sessionId: 's', signal: new AbortController().signal } as ToolContext
    const page = { targetId: 't', documentId: 'd', revision: 1 }; const values = [{ id: 'a', value: 'x' }]
    const tool = createFillFieldsTool(host)
    expect(await tool.execute({ page, values }, ctx)).toEqual({ ok: true, data: { fields } })
    expect(fillFields).toHaveBeenCalledWith({ page, values }, ctx); expect(tool).toMatchObject({ replayUnsafe: true, execution: { mode: 'serial' } })
  })
})
