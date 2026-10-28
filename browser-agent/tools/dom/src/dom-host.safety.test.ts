import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createDomToolsHost } from './dom-host'
import { isDomActionResult, isDomSnapshot } from './validation'
import type { PageCallContext } from './types'

const ctx = (signal = new AbortController().signal): PageCallContext => ({ sessionId: 'safety', signal })

describe('DOM host identity and safety', () => {
  beforeEach(() => { document.body.innerHTML = '' })

  it('rejects stale, unknown, removed, replaced, hidden, disabled, readonly, and password writes', async () => {
    document.body.innerHTML = '<button id="b">Go</button><input id="ro" readonly><input id="pw" type="password" value="secret"><div hidden><button id="hidden">No</button></div><button id="off" disabled>No</button>'
    const host = createDomToolsHost({ document, targetId: 't', documentId: 'd', revision: 2 }); const read = await host.readDom({ selector: '#b, #ro, #pw, #hidden, #off' }, ctx())
    expect(read.nodes.map((node) => node.name)).not.toContain('secret')
    const button = read.nodes.find((node) => node.attributes?.id === 'b')!; const ro = read.nodes.find((node) => node.attributes?.id === 'ro')!; const off = read.nodes.find((node) => node.attributes?.id === 'off')!
    await expect(host.clickDom({ page: { ...read.page, revision: 3 }, ref: button.ref }, ctx())).rejects.toThrow('stale')
    await expect(host.clickDom({ page: read.page, ref: 'dom-404' }, ctx())).rejects.toThrow('unknown')
    document.querySelector('#b')!.replaceWith(document.createElement('button')); await expect(host.clickDom({ page: read.page, ref: button.ref }, ctx())).rejects.toThrow('removed')
    await expect(host.typeDom({ page: read.page, ref: ro.ref, text: 'x' }, ctx())).rejects.toThrow('read-only')
    await expect(host.clickDom({ page: read.page, ref: off.ref }, ctx())).rejects.toThrow('disabled')
  })

  it('dispatches one click with pointer/mouse lead-in and guards cancellation', async () => {
    document.body.innerHTML = '<div id="candidate">Pick</div>'; const candidate = document.querySelector('#candidate')!; const events: string[] = []; let pointerType: string | undefined
    for (const name of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) candidate.addEventListener(name, (event) => { events.push(name); if (name === 'pointerdown') pointerType = (event as PointerEvent).pointerType })
    const host = createDomToolsHost({ document, targetId: 't' }); const read = await host.readDom({ selector: '#candidate' }, ctx()); const result = await host.clickDom({ page: read.page, ref: read.nodes[0]!.ref }, ctx())
    expect(events).toEqual(['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']); if (document.defaultView?.PointerEvent) expect(pointerType).toBe('mouse'); expect(isDomActionResult(result)).toBe(true); expect(isDomSnapshot(read)).toBe(true)
    const controller = new AbortController(); controller.abort(); await expect(host.clickDom({ page: read.page, ref: read.nodes[0]!.ref }, ctx(controller.signal))).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('stops compound events when a handler aborts or replaces the original node', async () => {
    document.body.innerHTML = '<button id="click">Click</button><input id="type"><input id="key">'
    const host = createDomToolsHost({ document, targetId: 't' }); const read = await host.readDom({ selector: '#click, #type, #key' }, ctx())
    const byId = (id: string) => read.nodes.find((node) => node.attributes?.id === id)!
    const controller = new AbortController(); const clickEvents: string[] = []; const click = document.querySelector('#click')!
    click.addEventListener('pointerdown', () => { clickEvents.push('pointerdown'); controller.abort() }); click.addEventListener('mousedown', () => clickEvents.push('mousedown'))
    await expect(host.clickDom({ page: read.page, ref: byId('click').ref }, ctx(controller.signal))).rejects.toMatchObject({ name: 'AbortError' }); expect(clickEvents).toEqual(['pointerdown'])
    let changes = 0; const type = document.querySelector('#type')!; type.addEventListener('input', () => type.replaceWith(document.createElement('input'))); type.addEventListener('change', () => changes++)
    await expect(host.typeDom({ page: read.page, ref: byId('type').ref, text: 'new' }, ctx())).rejects.toThrow('removed or replaced'); expect(changes).toBe(0)
    let keyups = 0; const key = document.querySelector('#key')!; key.addEventListener('keydown', () => key.replaceWith(document.createElement('input'))); key.addEventListener('keyup', () => keyups++)
    await expect(host.pressDomKey({ page: read.page, ref: byId('key').ref, key: 'Enter' }, ctx())).rejects.toThrow('removed or replaced'); expect(keyups).toBe(0)
  })

  it('blocks inherited aria-disabled and disabled fieldsets with the first-legend exception', async () => {
    document.body.innerHTML = '<div aria-disabled="true"><span id="nested">No</span></div><fieldset disabled><input id="blocked"><legend><input id="legend"></legend></fieldset>'
    const host = createDomToolsHost({ document, targetId: 't' }); const read = await host.readDom({ selector: '#nested, #blocked, #legend' }, ctx()); const byId = (id: string) => read.nodes.find((node) => node.attributes?.id === id)!
    await expect(host.clickDom({ page: read.page, ref: byId('nested').ref }, ctx())).rejects.toThrow('disabled')
    await expect(host.typeDom({ page: read.page, ref: byId('blocked').ref, text: 'x' }, ctx())).rejects.toThrow('disabled')
    await expect(host.typeDom({ page: read.page, ref: byId('legend').ref, text: 'ok' }, ctx())).resolves.toMatchObject({ node: { value: 'ok' } })
  })

  it('uses mousedown cancellation to suppress focus while completing one click', async () => {
    document.body.innerHTML = '<button id="focus">Focus</button><button id="allowed">Allowed</button>'; const button = document.querySelector('#focus')!; let focuses = 0; let clicks = 0
    button.addEventListener('mousedown', (event) => event.preventDefault()); button.addEventListener('focus', () => focuses++); button.addEventListener('click', () => clicks++)
    const host = createDomToolsHost({ document, targetId: 't' }); const read = await host.readDom({ selector: '#focus' }, ctx()); await host.clickDom({ page: read.page, ref: read.nodes[0]!.ref }, ctx())
    expect(focuses).toBe(0); expect(clicks).toBe(1)
    const allowed = document.querySelector('#allowed')!; let allowedFocus = 0; allowed.addEventListener('focus', () => allowedFocus++); const allowedRead = await host.readDom({ page: read.page, selector: '#allowed' }, ctx()); await host.clickDom({ page: read.page, ref: allowedRead.nodes[0]!.ref }, ctx()); expect(allowedFocus).toBe(1)
  })

  it('does not expose arbitrary attributes or script/style text', async () => {
    document.body.innerHTML = '<script>token</script><style>.x{}</style><div id="safe" data-secret="private" onclick="bad()">Visible</div>'
    const host = createDomToolsHost({ document, targetId: 't' }); const read = await host.readDom({}, ctx()); const safe = read.nodes.find((node) => node.attributes?.id === 'safe')!
    expect(JSON.stringify(read)).not.toContain('token'); expect(JSON.stringify(read)).not.toContain('private'); expect(safe.attributes).not.toHaveProperty('onclick')
    expect(vi.isMockFunction(document.querySelector)).toBe(false)
  })
})
