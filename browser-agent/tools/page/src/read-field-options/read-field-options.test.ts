import { describe, expect, it } from 'vitest'
import type { ToolContext } from '@einfach-agent/core/tools'
import { createDomPageHost } from '../dom-host'
import { createReadFieldOptionsTool } from './read-field-options'

const ctx = { sessionId: 's', signal: new AbortController().signal } as ToolContext

describe('read_field_options', () => {
  it('preserves duplicate stable values while filtering and paging', async () => {
    document.body.innerHTML = `<select><option value="x">Alpha</option><option value="x">Alpine</option><option value="y">Beta</option></select>`
    const host = createDomPageHost({ document, targetId: 't' }); const form = await host.readForm(ctx)
    const result = await createReadFieldOptionsTool(host).execute({ page: form.page, fieldId: form.fields[0].id, query: 'al', limit: 1 }, ctx)
    expect(result).toMatchObject({ ok: true, data: { options: [{ value: 'x', label: 'Alpha' }], optionsStatus: 'exposed', nextOffset: 1 } })
  })

  it('returns display-only labels without inventing values', async () => {
    document.body.innerHTML = `<div role="combobox" aria-label="City" aria-controls="cities"></div><div id="cities" role="listbox"><div role="option">Shanghai</div><div role="option">Beijing</div></div>`
    const host = createDomPageHost({ document, targetId: 't' }); const form = await host.readForm(ctx)
    const result = await createReadFieldOptionsTool(host).execute({ page: form.page, fieldId: form.fields[0].id }, ctx)
    expect(result).toMatchObject({ ok: true, data: { options: [{ label: 'Shanghai' }, { label: 'Beijing' }], optionsStatus: 'exposed' } })
  })

  it('distinguishes an unrendered popup from an exposed empty list', async () => {
    document.body.innerHTML = `<div role="combobox" aria-label="Closed"></div><div role="listbox" aria-label="Empty"></div>`
    const host = createDomPageHost({ document, targetId: 't' }); const form = await host.readForm(ctx)
    const closed = await createReadFieldOptionsTool(host).execute({ page: form.page, fieldId: form.fields[0].id }, ctx)
    const empty = await createReadFieldOptionsTool(host).execute({ page: form.page, fieldId: form.fields[1].id }, ctx)
    expect(closed).toMatchObject({ ok: false, error: expect.stringContaining('not exposed') })
    expect(empty).toMatchObject({ ok: true, data: { options: [], optionsStatus: 'exposed' } })
  })

  it('treats a popup under a hidden ancestor as not exposed', async () => {
    document.body.innerHTML = `<div role="combobox" aria-label="Closed" aria-controls="hidden-list"></div>
      <div aria-hidden="true"><div id="hidden-list" role="listbox"><div role="option" data-value="x">Hidden</div></div></div>`
    const host = createDomPageHost({ document, targetId: 't' }); const form = await host.readForm(ctx)
    expect(form.fields).toHaveLength(1)
    expect(form.fields[0]).toMatchObject({ optionsStatus: 'not-exposed', value: '' })
    expect(await createReadFieldOptionsTool(host).execute({ page: form.page, fieldId: form.fields[0].id }, ctx))
      .toMatchObject({ ok: false, error: expect.stringContaining('not exposed') })
  })
})
