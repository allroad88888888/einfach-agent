import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createDomPageHost } from './dom-host'
import type { PageCallContext } from './types'
const ctx = (signal = new AbortController().signal): PageCallContext => ({ sessionId: 'session', signal })
beforeEach(() => { document.body.innerHTML = '' })

describe('DOM page host native fields', () => {
  it('reads safe metadata, values, options, and unsupported complex controls', async () => {
    document.body.innerHTML = `<form><label for="name">Name</label><input id="name" name="name" required value="Ada"><input type="password" value="secret"><input type="hidden" value="token"><label><input type="checkbox" checked> Subscribe</label><select aria-label="Country"><option value="cn">China</option><option value="us" selected>USA</option></select><input type="file" aria-label="Upload"><div role="combobox" aria-label="City"></div></form>`
    const snapshot = await createDomPageHost({ document, targetId: 'tab-1', documentId: 'doc-1' }).readForm(ctx())
    expect(snapshot.page).toEqual({ targetId: 'tab-1', documentId: 'doc-1', revision: 1 })
    expect(snapshot.fields).toHaveLength(5)
    expect(snapshot.fields.map((field) => field.label)).toEqual(['Name', 'Subscribe', 'Country', 'Upload', 'City'])
    expect(snapshot.fields[0]).toMatchObject({ kind: 'text', value: 'Ada', required: true, supported: true })
    expect(snapshot.fields[2]).toMatchObject({ kind: 'select', value: 'us', options: [{ label: 'China', value: 'cn' }, { label: 'USA', value: 'us' }] })
    expect(snapshot.fields[3]).toMatchObject({ kind: 'input-file', supported: false })
    expect(snapshot.fields[4]).toMatchObject({ supported: false, readOnly: false })
  })

  it('fills native kinds, dispatches input/change, and reads actual values back', async () => {
    document.body.innerHTML = `<input aria-label="Text"><textarea aria-label="Bio"></textarea><input type="checkbox" aria-label="OK"><select aria-label="One"><option value="a">A</option><option value="b">B</option></select><select multiple aria-label="Many"><option value="x">X</option><option value="y">Y</option></select>`
    const host = createDomPageHost({ document, targetId: 't' }); const snapshot = await host.readForm(ctx())
    const events: string[] = []; for (const element of document.querySelectorAll('input,textarea,select')) { element.addEventListener('input', () => events.push('input')); element.addEventListener('change', () => events.push('change')) }
    const values = ['hello', 'bio', true, 'b', ['x', 'y']] as const
    const outcomes = await host.fillFields({ page: snapshot.page, values: snapshot.fields.map((field, index) => ({ id: field.id, value: values[index] })) }, ctx())
    expect(outcomes).toEqual(snapshot.fields.map((field, index) => ({ id: field.id, ok: true, value: values[index] })))
    expect(events).toEqual(Array(5).fill(['input', 'change']).flat())
  })

  it('reports partial failure for invalid types, disabled, unsupported, and absent IDs', async () => {
    document.body.innerHTML = `<input aria-label="Good"><input aria-label="Disabled" disabled><select aria-label="Pick"><option value="a">A</option></select><div role="combobox" aria-label="Fancy"></div>`
    const host = createDomPageHost({ document, targetId: 't' }); const snap = await host.readForm(ctx())
    const result = await host.fillFields({ page: snap.page, values: [{ id: snap.fields[0].id, value: 'yes' }, { id: snap.fields[1].id, value: 'no' }, { id: snap.fields[2].id, value: 'missing' }, { id: snap.fields[3].id, value: 'x' }, { id: 'unknown', value: 'x' }, { id: snap.fields[0].id, value: true }] }, ctx())
    expect(result.map((item) => item.ok)).toEqual([true, false, false, false, false, false])
    expect((document.querySelector('[aria-label="Good"]') as HTMLInputElement).value).toBe('yes')
  })

  it('validates constraints without submit or mutation', async () => {
    document.body.innerHTML = `<form><input aria-label="Email" type="email" required><input aria-label="Optional" value="same"></form>`
    const form = document.querySelector('form')!; const submit = vi.fn(); form.addEventListener('submit', submit)
    const host = createDomPageHost({ document, targetId: 't' }); const snap = await host.readForm(ctx())
    const outcomes = await host.validateForm({ page: snap.page }, ctx())
    expect(outcomes[0]).toMatchObject({ ok: false, value: '' }); expect(outcomes[1]).toEqual({ id: snap.fields[1].id, ok: true, value: 'same' })
    expect(submit).not.toHaveBeenCalled(); expect((document.querySelector('[aria-label="Optional"]') as HTMLInputElement).value).toBe('same')
  })
})
