import { beforeEach, describe, expect, it } from 'vitest'
import type { ToolContext } from '@einfach-agent/core/tools'
import { createDomPageHost } from '../dom-host'
const ctx = { sessionId: 's', signal: new AbortController().signal } as ToolContext
describe('read_table host', () => {
  beforeEach(() => { document.body.innerHTML = '' })
  it('paginates visible semantic rows and expires replaced ids', async () => {
    document.body.innerHTML = `<table><caption>People <span style="visibility:collapse">secret</span><details><summary>Info</summary><span>closed secret</span></details></caption><tr><th>Name</th><th style="display:none">Hidden</th></tr><tr><td>Ada<input value="private"><details><summary>More</summary><span>cell secret</span></details></td><td style="display:none">x</td></tr><tr><td>Lin</td></tr></table>`
    const host = createDomPageHost({ document, targetId: 't', documentId: 'd' }); const page = await host.readPage!({}, ctx)
    expect(page.tables[0]).toMatchObject({ caption: 'People Info', rowCount: 3, columnCount: 1 })
    const result = await host.readTable!({ page: page.page, tableId: page.tables[0].id, limit: 1 }, ctx)
    expect(result).toMatchObject({ headers: ['Name'], rows: [['Ada More']], nextOffset: 1, truncated: true })
    expect(JSON.stringify(result)).not.toContain('secret')
    document.querySelector('table')!.outerHTML = '<table><tr><td>new</td></tr></table>'
    await expect(host.readTable!({ page: page.page, tableId: page.tables[0].id }, ctx)).rejects.toThrow('replaced')
  })
})
