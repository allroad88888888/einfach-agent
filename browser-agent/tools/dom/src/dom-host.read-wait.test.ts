import { beforeEach, describe, expect, it } from 'vitest'
import { createDomToolsHost } from './dom-host'
import type { PageCallContext } from './types'

const ctx = (signal = new AbortController().signal): PageCallContext => ({ sessionId: 'read', signal })

describe('DOM read and wait bounds', () => {
  beforeEach(() => { document.body.innerHTML = '' })

  it('finds a filtered tail node, paginates, and scopes by an observed container', async () => {
    const scope = document.createElement('section'); scope.id = 'scope'
    for (let index = 0; index < 600; index++) { const node = document.createElement('div'); node.textContent = index === 599 ? 'tail target' : `row ${index}`; scope.append(node) }
    document.body.append(scope); const host = createDomToolsHost({ document, targetId: 't' })
    const tail = await host.readDom({ text: 'tail target' }, ctx()); expect(tail.nodes.some((node) => node.text === 'tail target')).toBe(true)
    const first = await host.readDom({ selector: '#scope > div', limit: 10 }, ctx()); expect(first.truncated).toBe(true); expect(first.nextOffset).toBe(10)
    const second = await host.readDom({ page: first.page, scopeRef: first.nodes[0]!.parentRef, selector: 'div', offset: first.nextOffset, limit: 10 }, ctx()); expect(second.nodes[0]?.text).toBe('row 10')
  })

  it('waits for present and absent, times out clearly, and cancels promptly', async () => {
    const host = createDomToolsHost({ document, targetId: 't' }); const page = (await host.readDom({}, ctx())).page
    setTimeout(() => { const node = document.createElement('span'); node.textContent = 'later'; document.body.append(node) }, 5)
    expect((await host.waitForDom({ page, text: 'later', timeoutMs: 200 }, ctx())).nodes[0]?.text).toBe('later')
    document.querySelector('span')!.remove(); expect((await host.waitForDom({ page, text: 'later', condition: 'absent', timeoutMs: 50 }, ctx())).nodes).toEqual([])
    await expect(host.waitForDom({ page, text: 'never', timeoutMs: 0 }, ctx())).rejects.toThrow('timed out')
    const controller = new AbortController(); const pending = host.waitForDom({ page, text: 'never', timeoutMs: 1000 }, ctx(controller.signal)); controller.abort(); await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects malformed selectors and direct-call bounds', async () => {
    const host = createDomToolsHost({ document, targetId: 't' })
    await expect(host.readDom({ selector: '[', limit: 101 }, ctx())).rejects.toThrow('limit')
    await expect(host.readDom({ selector: '[' }, ctx())).rejects.toThrow('invalid selector')
  })
})
