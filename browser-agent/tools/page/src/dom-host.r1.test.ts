import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createDomPageHost } from './dom-host'
import type { ControlledFieldAdapter, PageCallContext } from './types'

const ctx = (signal = new AbortController().signal): PageCallContext => ({ sessionId: 's', signal })
beforeEach(() => { document.body.innerHTML = '' })

function dataAdapter(write?: ControlledFieldAdapter['write']): ControlledFieldAdapter {
  return {
    kind: 'controlled',
    matches: (element) => element.hasAttribute('data-controlled'),
    read: (element) => ({ label: element.getAttribute('aria-label') ?? '', value: element.getAttribute('data-value') ?? '', required: false, readOnly: false, supported: true }),
    write: write ?? ((element, value) => { element.setAttribute('data-value', String(value)) }),
  }
}

describe('DOM host R1 safety and ordering', () => {
  it('never exposes password or hidden values even when an adapter matches them', async () => {
    document.body.innerHTML = `<input type="password" value="secret" data-controlled><input type="hidden" value="token" data-controlled><input value="safe" aria-label="Safe">`
    const broad: ControlledFieldAdapter = { ...dataAdapter(), matches: (element) => element instanceof HTMLInputElement, read: (element) => ({ label: 'adapted', value: (element as HTMLInputElement).value, required: false, readOnly: false, supported: true }) }
    const snapshot = await createDomPageHost({ document, targetId: 't', controlledAdapters: [broad] }).readForm(ctx())
    expect(snapshot.fields).toHaveLength(1); expect(snapshot.fields[0].value).toBe('safe')
  })

  it('lets an explicit adapter take priority over native handling', async () => {
    document.body.innerHTML = `<input data-controlled data-value="model" value="native" aria-label="Name">`
    const write = vi.fn((element: Element, value) => { element.setAttribute('data-value', `adapted:${String(value)}`) })
    const adapter = dataAdapter(write); const host = createDomPageHost({ document, targetId: 't', controlledAdapters: [adapter] }); const snap = await host.readForm(ctx())
    expect(snap.fields[0]).toMatchObject({ kind: 'controlled', value: 'model' })
    const result = await host.fillFields({ page: snap.page, values: [{ id: snap.fields[0].id, value: 'next' }] }, ctx())
    expect(write).toHaveBeenCalledOnce(); expect(result[0]).toMatchObject({ ok: false, value: 'adapted:next' })
    expect((document.querySelector('input') as HTMLInputElement).value).toBe('native')
  })

  it('still enforces native disabled state when an adapter takes ownership', async () => {
    document.body.innerHTML = `<input data-controlled data-value="old" disabled aria-label="Name">`
    const write = vi.fn(); const host = createDomPageHost({ document, targetId: 't', controlledAdapters: [dataAdapter(write)] }); const snap = await host.readForm(ctx())
    expect(snap.fields[0].readOnly).toBe(true)
    expect((await host.fillFields({ page: snap.page, values: [{ id: snap.fields[0].id, value: 'new' }] }, ctx()))[0]).toMatchObject({ ok: false, error: 'field is disabled or read-only' })
    expect(write).not.toHaveBeenCalled()
  })

  it('reports browser normalization and event rollback as failures with actual values', async () => {
    document.body.innerHTML = `<input type="number" aria-label="Count"><input aria-label="Guard" value="old">`
    const host = createDomPageHost({ document, targetId: 't' }); const snap = await host.readForm(ctx())
    document.querySelector('[aria-label="Guard"]')!.addEventListener('change', (event) => { (event.currentTarget as HTMLInputElement).value = 'old' })
    const outcomes = await host.fillFields({ page: snap.page, values: [{ id: snap.fields[0].id, value: 'abc' }, { id: snap.fields[1].id, value: 'new' }] }, ctx())
    expect(outcomes).toEqual([
      { id: snap.fields[0].id, ok: false, value: '', error: 'field did not retain the requested value' },
      { id: snap.fields[1].id, ok: false, value: 'old', error: 'field did not retain the requested value' },
    ])
  })

  it('compares multi-select results as sets rather than array order', async () => {
    document.body.innerHTML = `<select multiple><option value="a">A</option><option value="b">B</option></select>`
    const host = createDomPageHost({ document, targetId: 't' }); const snap = await host.readForm(ctx())
    const result = await host.fillFields({ page: snap.page, values: [{ id: snap.fields[0].id, value: ['b', 'a'] }] }, ctx())
    expect(result[0]).toEqual({ id: snap.fields[0].id, ok: true, value: ['a', 'b'] })
  })

  it('serializes writes across DOM hosts sharing a document and preserves call order', async () => {
    document.body.innerHTML = `<div data-controlled data-value="0"></div>`
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve }); const starts: string[] = []
    const adapter = dataAdapter(async (element, value) => { starts.push(String(value)); if (value === 'first') await gate; element.setAttribute('data-value', String(value)) })
    const firstHost = createDomPageHost({ document, targetId: 't', documentId: 'd', controlledAdapters: [adapter] })
    const secondHost = createDomPageHost({ document, targetId: 't', documentId: 'd', controlledAdapters: [adapter] })
    const firstSnap = await firstHost.readForm(ctx()); const secondSnap = await secondHost.readForm(ctx())
    const first = firstHost.fillFields({ page: firstSnap.page, values: [{ id: firstSnap.fields[0].id, value: 'first' }] }, ctx())
    const second = secondHost.fillFields({ page: secondSnap.page, values: [{ id: secondSnap.fields[0].id, value: 'second' }] }, ctx())
    await vi.waitFor(() => expect(starts).toEqual(['first'])); release(); await Promise.all([first, second])
    expect(starts).toEqual(['first', 'second']); expect(document.querySelector('div')!.getAttribute('data-value')).toBe('second')
  })

  it('does not let a failed write block the queue and rejects queued cancellation before writing', async () => {
    document.body.innerHTML = `<div data-controlled data-value="0"></div>`; let calls = 0
    const adapter = dataAdapter((element, value) => { calls++; if (value === 'fail') throw new Error('failed'); element.setAttribute('data-value', String(value)) })
    const host = createDomPageHost({ document, targetId: 't', controlledAdapters: [adapter] }); const snap = await host.readForm(ctx())
    const failed = host.fillFields({ page: snap.page, values: [{ id: snap.fields[0].id, value: 'fail' }] }, ctx())
    const controller = new AbortController(); const cancelled = host.fillFields({ page: snap.page, values: [{ id: snap.fields[0].id, value: 'cancelled' }] }, ctx(controller.signal)); controller.abort()
    const final = host.fillFields({ page: snap.page, values: [{ id: snap.fields[0].id, value: 'final' }] }, ctx())
    expect((await failed)[0]).toMatchObject({ ok: false, error: 'failed' }); await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' }); expect((await final)[0].ok).toBe(true)
    expect(calls).toBe(2); expect(document.querySelector('div')!.getAttribute('data-value')).toBe('final')
  })

  it('rechecks document validity before every field in a batch', async () => {
    document.body.innerHTML = `<input value="one"><input value="two">`; const host = createDomPageHost({ document, targetId: 't' }); const snap = await host.readForm(ctx())
    const ownDescriptor = Object.getOwnPropertyDescriptor(document, 'defaultView')
    document.querySelector('input')!.addEventListener('change', () => { Object.defineProperty(document, 'defaultView', { configurable: true, value: { document: document.implementation.createHTMLDocument() } }) })
    try {
      const result = await host.fillFields({ page: snap.page, values: [{ id: snap.fields[0].id, value: 'changed' }, { id: snap.fields[1].id, value: 'wrong' }] }, ctx())
      expect(result[0]).toMatchObject({ ok: false, error: 'document binding is no longer current' }); expect(result[1]).toMatchObject({ ok: false, error: 'document binding is no longer current' })
      expect(document.querySelectorAll('input')[1].value).toBe('two')
    } finally { if (ownDescriptor) Object.defineProperty(document, 'defaultView', ownDescriptor); else Reflect.deleteProperty(document, 'defaultView') }
  })
})
