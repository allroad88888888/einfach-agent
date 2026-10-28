import type { ToolContext } from '@einfach-agent/core/tools'
import { describe, expect, it, vi } from 'vitest'
import { createDomPageHost } from '../dom-host'
import type { FormSnapshot, PageToolsHost } from '../types'
import { createWaitForFieldTool } from './wait-for-field'

const context = (signal = new AbortController().signal) => ({ sessionId: 's', signal }) as ToolContext

describe('wait_for_field', () => {
  it('waits until options arrive', async () => {
    vi.useFakeTimers(); document.body.innerHTML = '<select></select>'
    const host = createDomPageHost({ document, targetId: 't' }); const form = await host.readForm(context())
    const pending = createWaitForFieldTool(host).execute({ page: form.page, fieldId: form.fields[0].id, condition: 'options', timeoutMs: 500 }, context())
    document.querySelector('select')!.append(new Option('A', 'a')); await vi.advanceTimersByTimeAsync(100)
    expect(await pending).toMatchObject({ ok: true }); vi.useRealTimers()
  })

  it('waits for an exact value', async () => {
    vi.useFakeTimers(); document.body.innerHTML = '<input value="old">'
    const host = createDomPageHost({ document, targetId: 't' }); const form = await host.readForm(context())
    const pending = createWaitForFieldTool(host).execute({ page: form.page, fieldId: form.fields[0].id, condition: 'value', value: 'new', timeoutMs: 500 }, context())
    document.querySelector('input')!.value = 'new'; await vi.advanceTimersByTimeAsync(100)
    expect(await pending).toMatchObject({ ok: true, data: { field: { value: 'new' } } }); vi.useRealTimers()
  })

  it('fails when the exact field is replaced or the page is stale', async () => {
    document.body.innerHTML = '<input>'
    const host = createDomPageHost({ document, targetId: 't' }); const form = await host.readForm(context())
    document.querySelector('input')!.outerHTML = '<input>'
    expect(await createWaitForFieldTool(host).execute({ page: form.page, fieldId: form.fields[0].id, condition: 'ready' }, context())).toMatchObject({ ok: false, error: expect.stringContaining('replaced') })
    expect(await createWaitForFieldTool(host).execute({ page: { ...form.page, revision: 2 }, fieldId: form.fields[0].id, condition: 'ready' }, context())).toMatchObject({ ok: false, error: expect.stringContaining('stale') })
  })

  it('cleans up promptly on abort', async () => {
    document.body.innerHTML = '<input disabled>'
    const host = createDomPageHost({ document, targetId: 't' }); const form = await host.readForm(context()); const controller = new AbortController()
    const pending = createWaitForFieldTool(host).execute({ page: form.page, fieldId: form.fields[0].id, condition: 'ready', timeoutMs: 1000 }, context(controller.signal))
    controller.abort(); expect(await pending).toMatchObject({ ok: false })
  })

  it('times out even when readForm never returns and ignores its late result', async () => {
    vi.useFakeTimers(); let resolve!: (value: FormSnapshot) => void
    const readForm = new Promise<FormSnapshot>((done) => { resolve = done })
    const host = { readForm: () => readForm, fillFields: async () => [], validateForm: async () => [] } as PageToolsHost
    const pending = createWaitForFieldTool(host).execute({ page: { targetId: 't', documentId: 'd', revision: 1 }, fieldId: 'f', condition: 'ready', timeoutMs: 10 }, context())
    await vi.advanceTimersByTimeAsync(10); expect(await pending).toMatchObject({ ok: false })
    resolve({ page: { targetId: 't', documentId: 'd', revision: 1 }, fields: [] }); vi.useRealTimers()
  })
})
