import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '@einfach-agent/core/tools'
import { createValidateFormTool } from './validate-form'
import type { PageToolsHost } from '../types'
describe('validate_form tool', () => {
  it('forwards an optional field subset and returns structured host results', async () => {
    const fields = [{ id: 'a', ok: false, value: '', error: 'required' }]
    const validateForm = vi.fn(async () => fields); const host = { validateForm } as unknown as PageToolsHost
    const ctx = { sessionId: 's', signal: new AbortController().signal } as ToolContext
    const page = { targetId: 't', documentId: 'd', revision: 1 }; const tool = createValidateFormTool(host)
    expect(await tool.execute({ page, fieldIds: ['a'] }, ctx)).toEqual({ ok: true, data: { fields } })
    expect(validateForm).toHaveBeenCalledWith({ page, fieldIds: ['a'] }, ctx); expect(tool.replayUnsafe).toBeUndefined()
  })
})
