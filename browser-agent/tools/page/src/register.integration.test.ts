import { beforeEach, describe, expect, it } from 'vitest'
import { createCore } from '@einfach-agent/core/plugin'
import type { ToolContext } from '@einfach-agent/core/tools'
import { createDomPageHost } from './dom-host'
import { registerPageTools } from './register'

beforeEach(() => { document.body.innerHTML = '' })
const context = (): ToolContext => ({ sessionId: 'session', signal: new AbortController().signal } as ToolContext)

describe('page package registration', () => {
  it('completes a read/fill/validate loop in an isolated core registry', async () => {
    document.body.innerHTML = `<input aria-label="Name" required>`
    const host = createDomPageHost({ document, targetId: 'target', documentId: 'document' })
    const core = createCore({ registerTools: (registry) => registerPageTools(registry, host) })
    expect(core.tools.list().map(({ name }) => name)).toEqual(['read_form', 'fill_fields', 'validate_form'])
    const read = await core.tools.run('read_form', {}, context())
    if (!('ok' in read)) throw new Error('read paused')
    expect(read.ok).toBe(true)
    if (!read.ok) throw new Error('read failed')
    const snapshot = read.data as Awaited<ReturnType<typeof host.readForm>>
    const fill = await core.tools.run('fill_fields', { page: snapshot.page, values: [{ id: snapshot.fields[0].id, value: 'Ada' }] }, context())
    expect(fill).toMatchObject({ ok: true, data: { fields: [{ ok: true, value: 'Ada' }] } })
    const validate = await core.tools.run('validate_form', { page: snapshot.page }, context())
    expect(validate).toMatchObject({ ok: true, data: { fields: [{ ok: true, value: 'Ada' }] } })
  })

  it('rejects invalid value types at the registry schema before the host writes', async () => {
    document.body.innerHTML = `<input aria-label="Name" value="safe">`
    const host = createDomPageHost({ document, targetId: 'target' }); const core = createCore({ registerTools: (registry) => registerPageTools(registry, host) })
    const snapshot = await host.readForm(context())
    const result = await core.tools.run('fill_fields', { page: snapshot.page, values: [{ id: snapshot.fields[0].id, value: 42 }] }, context())
    expect(result).toMatchObject({ ok: false }); expect(document.querySelector('input')!.value).toBe('safe')
  })
})
