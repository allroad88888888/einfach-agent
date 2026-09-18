import { beforeEach, describe, expect, it } from 'vitest'
import { createDomPageHost } from './dom-host'
import type { ControlledFieldAdapter, PageCallContext } from './types'
const ctx = (signal = new AbortController().signal): PageCallContext => ({ sessionId: 's', signal })
beforeEach(() => { document.body.innerHTML = '' })

describe('DOM page identity and cancellation', () => {
  it('uses element identity instead of duplicate labels', async () => {
    document.body.innerHTML = `<label>Code<input value="first"></label><label>Code<input value="second"></label>`
    const host = createDomPageHost({ document, targetId: 't' }); const snap = await host.readForm(ctx())
    await host.fillFields({ page: snap.page, values: [{ id: snap.fields[1].id, value: 'changed' }] }, ctx())
    expect(Array.from(document.querySelectorAll('input'), (input) => input.value)).toEqual(['first', 'changed'])
  })

  it('rejects a replaced field ID and does not write the replacement', async () => {
    document.body.innerHTML = `<input aria-label="Name" value="old">`
    const host = createDomPageHost({ document, targetId: 't' }); const snap = await host.readForm(ctx())
    document.querySelector('input')!.outerHTML = `<input aria-label="Name" value="new">`
    const result = await host.fillFields({ page: snap.page, values: [{ id: snap.fields[0].id, value: 'wrong' }] }, ctx())
    expect(result[0]).toMatchObject({ ok: false, error: expect.stringContaining('replaced') })
    expect(document.querySelector('input')!.value).toBe('new')
  })

  it('rejects target, document, and revision mismatches before mutation', async () => {
    document.body.innerHTML = `<input value="safe">`; const host = createDomPageHost({ document, targetId: 't', documentId: 'd', revision: 4 }); const snap = await host.readForm(ctx())
    for (const page of [{ ...snap.page, targetId: 'other' }, { ...snap.page, documentId: 'other' }, { ...snap.page, revision: 5 }]) {
      const result = await host.fillFields({ page, values: [{ id: snap.fields[0].id, value: 'wrong' }] }, ctx()); expect(result[0].ok).toBe(false)
    }
    expect(document.querySelector('input')!.value).toBe('safe')
  })

  it('aborts before any write', async () => {
    document.body.innerHTML = `<input value="safe">`; const host = createDomPageHost({ document, targetId: 't' }); const snap = await host.readForm(ctx())
    const controller = new AbortController(); controller.abort()
    await expect(host.fillFields({ page: snap.page, values: [{ id: snap.fields[0].id, value: 'wrong' }] }, ctx(controller.signal))).rejects.toMatchObject({ name: 'AbortError' })
    expect(document.querySelector('input')!.value).toBe('safe')
  })

  it('supports an explicit controlled adapter and rejects a late cancelled result', async () => {
    document.body.innerHTML = `<div data-controlled aria-label="First rating" data-value="1"></div><div data-controlled aria-label="Second rating" data-value="2"></div>`
    let release!: () => void; const waiting = new Promise<void>((resolve) => { release = resolve })
    let markEntered!: () => void; const entered = new Promise<void>((resolve) => { markEntered = resolve })
    const adapter: ControlledFieldAdapter = {
      kind: 'rating', matches: (element) => element.hasAttribute('data-controlled'),
      read: (element) => ({ label: element.getAttribute('aria-label') ?? '', value: element.getAttribute('data-value') ?? '', required: true, readOnly: false, supported: true }),
      async write(element, value) { markEntered(); await waiting; element.setAttribute('data-value', String(value)) },
      validate: (element) => element.getAttribute('data-value') === '5' ? undefined : 'rating must be 5',
    }
    const host = createDomPageHost({ document, targetId: 't', controlledAdapters: [adapter] }); const snap = await host.readForm(ctx())
    expect(snap.fields[0]).toMatchObject({ kind: 'rating', value: '1', supported: true })
    const controller = new AbortController(); const pending = host.fillFields({ page: snap.page, values: [{ id: snap.fields[0].id, value: '5' }, { id: snap.fields[1].id, value: '5' }] }, ctx(controller.signal))
    await entered; controller.abort(); release(); await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    const reread = await host.readForm(ctx()); expect(reread.fields.map(({ value }) => value)).toEqual(['5', '2'])
    expect((await host.validateForm({ page: reread.page }, ctx())).map(({ ok }) => ok)).toEqual([true, false])
  })

  it('writes and reads back an adapted controlled component', async () => {
    document.body.innerHTML = `<div data-rating="2"></div>`
    const adapter: ControlledFieldAdapter = {
      kind: 'rating', matches: (element) => element.hasAttribute('data-rating'),
      read: (element) => ({ label: 'Rating', value: element.getAttribute('data-rating') ?? '', required: false, readOnly: false, supported: true }),
      write: (element, value) => { element.setAttribute('data-rating', String(value)) },
    }
    const host = createDomPageHost({ document, targetId: 't', controlledAdapters: [adapter] }); const snapshot = await host.readForm(ctx())
    expect(await host.fillFields({ page: snapshot.page, values: [{ id: snapshot.fields[0].id, value: '5' }] }, ctx())).toEqual([{ id: snapshot.fields[0].id, ok: true, value: '5' }])
  })
})
