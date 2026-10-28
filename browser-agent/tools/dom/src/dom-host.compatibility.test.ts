import { beforeEach, describe, expect, it } from 'vitest'
import { createDomPageHost } from '@einfach-agent/tools-browser-page'
import { createDomToolsHost } from './dom-host'
import type { PageCallContext } from './types'

const ctx: PageCallContext = { sessionId: 'compat', signal: new AbortController().signal }
describe('ARIA and native form compatibility', () => {
  beforeEach(() => { document.body.innerHTML = '' })
  it('uses ARIA combobox handlers to expand, select, and read back', async () => {
    document.body.innerHTML = '<div id="combo" role="combobox" tabindex="0" aria-expanded="false"><span id="value">Choose</span></div>'
    const combo = document.querySelector('#combo')!; combo.addEventListener('click', () => { combo.setAttribute('aria-expanded', 'true'); const list = document.createElement('div'); list.id = 'list'; list.setAttribute('role', 'listbox'); list.innerHTML = '<div role="option">Alpha</div><div role="option">Beta</div>'; list.addEventListener('click', (event) => { const option = (event.target as Element).closest('[role=option]'); if (!option) return; document.querySelector('#value')!.textContent = option.textContent; combo.setAttribute('aria-expanded', 'false'); list.remove() }); document.body.append(list) })
    const host = createDomToolsHost({ document, targetId: 't' }); const initial = await host.readDom({ selector: '#combo' }, ctx); await host.clickDom({ page: initial.page, ref: initial.nodes[0]!.ref }, ctx)
    expect((await host.readDom({ page: initial.page, selector: '#combo' }, ctx)).nodes[0]?.expanded).toBe(true)
    const option = (await host.readDom({ page: initial.page, selector: '[role=option]', text: 'Beta' }, ctx)).nodes[0]!; await host.clickDom({ page: initial.page, ref: option.ref }, ctx)
    expect((await host.readDom({ page: initial.page, selector: '#value' }, ctx)).nodes[0]?.text).toBe('Beta')
  })
  it('preserves native select value/change behavior through the existing page host', async () => {
    document.body.innerHTML = '<label for="kind">Kind</label><select id="kind"><option value="a">Alpha</option><option value="b">Beta label</option></select>'; let changes = 0; document.querySelector('#kind')!.addEventListener('change', () => changes++)
    const pageHost = createDomPageHost({ document, targetId: 't' }); const form = await pageHost.readForm(ctx); const field = form.fields.find((item) => item.label === 'Kind')!
    const outcomes = await pageHost.fillFields({ page: form.page, values: [{ id: field.id, value: 'b' }] }, ctx); expect(outcomes).toEqual([{ id: field.id, ok: true, value: 'b' }]); expect(changes).toBe(1)
    const domHost = createDomToolsHost({ document, targetId: 't' }); const select = await domHost.readDom({ selector: '#kind' }, ctx); expect(select.nodes[0]?.value).toBe('b'); expect(select.nodes[0]?.name).toBe('Kind')
  })
})
