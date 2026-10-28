import { beforeEach, describe, expect, it } from 'vitest'
import { createDomPageHost } from './dom-host'
import type { PageCallContext } from './types'

const ctx = (): PageCallContext => ({ sessionId: 'iframe-session', signal: new AbortController().signal })

beforeEach(() => { document.body.innerHTML = '' })

function frameDocument(markup: string): Document {
  const frame = document.createElement('iframe')
  document.body.append(frame)
  const doc = frame.contentDocument!
  doc.body.innerHTML = markup
  return doc
}

describe('DOM page host same-origin iframe documents', () => {
  it('reads, fills, and validates native fields from the document realm', async () => {
    const doc = frameDocument(`<form>
      <label for="name">Name</label><input id="name" required>
      <label for="country">Country</label><select id="country"><option value="cn">China</option><option value="us">USA</option></select>
      <label for="tags">Tags</label><select id="tags" multiple><option value="a">A</option><option value="b">B</option></select>
      <label><input type="checkbox"> Subscribe</label>
      <input type="password" value="secret"><input type="hidden" value="token">
    </form>`)
    const host = createDomPageHost({ document: doc, targetId: 'frame-a', documentId: 'doc-a' })
    const snapshot = await host.readForm(ctx())

    expect(snapshot.fields.map(({ label, kind }) => ({ label, kind }))).toEqual([
      { label: 'Name', kind: 'text' }, { label: 'Country', kind: 'select' },
      { label: 'Tags', kind: 'select-multiple' }, { label: 'Subscribe', kind: 'checkbox' },
    ])
    const values = ['Ada', 'us', ['a', 'b'], true] as const
    const filled = await host.fillFields({ page: snapshot.page, values: snapshot.fields.map((field, index) => ({ id: field.id, value: values[index] })) }, ctx())
    expect(filled.every(({ ok }) => ok)).toBe(true)
    expect(await host.validateForm({ page: snapshot.page }, ctx())).toEqual(
      snapshot.fields.map((field, index) => ({ id: field.id, ok: true, value: values[index] })),
    )
  })

  it('keeps field identities and write queues isolated between documents', async () => {
    const firstDoc = frameDocument('<label for="value">First</label><input id="value" value="one">')
    const secondDoc = frameDocument('<label for="value">Second</label><input id="value" value="two">')
    const firstHost = createDomPageHost({ document: firstDoc, targetId: 'first' })
    const secondHost = createDomPageHost({ document: secondDoc, targetId: 'second' })
    const [first, second] = await Promise.all([firstHost.readForm(ctx()), secondHost.readForm(ctx())])

    await Promise.all([
      firstHost.fillFields({ page: first.page, values: [{ id: first.fields[0].id, value: 'changed-one' }] }, ctx()),
      secondHost.fillFields({ page: second.page, values: [{ id: second.fields[0].id, value: 'changed-two' }] }, ctx()),
    ])
    expect(firstDoc.querySelector('input')!.value).toBe('changed-one')
    expect(secondDoc.querySelector('input')!.value).toBe('changed-two')
    expect(first.fields[0].label).toBe('First')
    expect(second.fields[0].label).toBe('Second')
  })

  it('reads visible page and table content in the bound document realm', async () => {
    const doc = frameDocument(`<p>Frame body</p><details><summary>Summary</summary><p>closed secret</p></details>
      <table><caption>Frame table <span style="visibility:collapse">hidden</span></caption><tr><th>Name</th></tr><tr><td>Ada</td></tr></table>`)
    const host = createDomPageHost({ document: doc, targetId: 'frame-read', documentId: 'frame-doc' })
    const page = await host.readPage!({}, ctx())
    expect(page.text).toContain('Frame body Summary Frame table Name Ada')
    expect(page.text).not.toMatch(/closed secret|hidden/)
    expect(page.tables).toEqual([{ id: 'table-1', caption: 'Frame table', rowCount: 2, columnCount: 1 }])
    expect(await host.readTable!({ page: page.page, tableId: page.tables[0].id }, ctx())).toMatchObject({ headers: ['Name'], rows: [['Ada']] })
    doc.querySelector('table')!.outerHTML = '<table><tr><td>replacement</td></tr></table>'
    await expect(host.readTable!({ page: page.page, tableId: page.tables[0].id }, ctx())).rejects.toThrow('replaced')
  })
})
