import { describe, expect, it } from 'vitest'
import { createDomPageHost } from '@einfach-agent/tools-browser-page'
import { createDomToolsHost } from './dom-host'
import type { PageCallContext } from './types'

const ctx: PageCallContext = { sessionId: 'queue', signal: new AbortController().signal }
describe('shared document write queue', () => {
  it('does not interleave DOM actions with page fillFields', async () => {
    document.body.innerHTML = '<input id="field" value="old"><button id="action">click</button>'; const order: string[] = []
    const pageHost = createDomPageHost({ document, targetId: 't', controlledAdapters: [{ kind: 'text', matches: (element) => element.id === 'field', read: (element) => ({ label: 'field', value: (element as HTMLInputElement).value, required: false, readOnly: false, supported: true }), async write(element, value) { order.push('fill:start'); await new Promise((resolve) => setTimeout(resolve, 10)); (element as HTMLInputElement).value = String(value); order.push('fill:end') } }] })
    const form = await pageHost.readForm(ctx); document.querySelector('#action')!.addEventListener('click', () => order.push('click'))
    const domHost = createDomToolsHost({ document, targetId: 't' }); const dom = await domHost.readDom({ selector: '#action' }, ctx)
    const filling = pageHost.fillFields({ page: form.page, values: [{ id: form.fields[0]!.id, value: 'new' }] }, ctx); const clicking = domHost.clickDom({ page: dom.page, ref: dom.nodes[0]!.ref }, ctx)
    await Promise.all([filling, clicking]); expect(order).toEqual(['fill:start', 'fill:end', 'click'])
  })
})
