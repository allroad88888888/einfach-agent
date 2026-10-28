import { beforeEach, describe, expect, it } from 'vitest'
import { createDomToolsHost } from './dom-host'
import type { PageCallContext } from './types'

const ctx: PageCallContext = { sessionId: 'actions', signal: new AbortController().signal }
describe('DOM input, key, scroll, and semantic controls', () => {
  beforeEach(() => { document.body.innerHTML = '' })
  it('updates text with input/change, dispatches keys, and reads ARIA state', async () => {
    document.body.innerHTML = '<label for="q">Search</label><input id="q"><div id="combo" role="combobox" aria-expanded="false">Choice</div>'
    const input = document.querySelector('#q')!; const events: string[] = []; input.addEventListener('input', () => events.push('input')); input.addEventListener('change', () => events.push('change')); input.addEventListener('keydown', (event) => events.push((event as KeyboardEvent).key))
    const host = createDomToolsHost({ document, targetId: 't' }); const found = await host.readDom({ selector: '#q, #combo' }, ctx); const inputNode = found.nodes.find((node) => node.attributes?.id === 'q')!; const combo = found.nodes.find((node) => node.role === 'combobox')!
    const typed = await host.typeDom({ page: found.page, ref: inputNode.ref, text: 'abc' }, ctx); await host.pressDomKey({ page: found.page, ref: inputNode.ref, key: 'Enter' }, ctx)
    expect(typed.node?.value).toBe('abc'); expect(events).toEqual(['input', 'change', 'Enter']); expect(combo.expanded).toBe(false)
  })
  it('scrolls with a bounded amount and rejects unsafe amounts', async () => {
    document.body.innerHTML = '<div id="pane">content</div>'; const pane = document.querySelector('#pane') as HTMLElement; Object.defineProperty(pane, 'scrollBy', { value: undefined }); const host = createDomToolsHost({ document, targetId: 't' }); const read = await host.readDom({ selector: '#pane' }, ctx)
    await host.scrollDom({ page: read.page, ref: read.nodes[0]!.ref, direction: 'down', amount: 40 }, ctx); expect(pane.scrollTop).toBe(40)
    await expect(host.scrollDom({ page: read.page, ref: read.nodes[0]!.ref, direction: 'down', amount: 10001 }, ctx)).rejects.toThrow('10000')
  })
  it('uses constructors from an explicitly supplied same-origin iframe document', async () => {
    const iframe = document.createElement('iframe'); document.body.append(iframe); const child = iframe.contentDocument!; child.body.innerHTML = '<input id="inside">'
    const host = createDomToolsHost({ document: child, targetId: 'frame' }); const read = await host.readDom({ selector: '#inside' }, ctx); const result = await host.typeDom({ page: read.page, ref: read.nodes[0]!.ref, text: 'frame value' }, ctx)
    expect(result.node?.value).toBe('frame value')
  })
})
