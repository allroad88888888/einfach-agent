import { beforeEach, describe, expect, it } from 'vitest'
import type { ToolContext } from '@einfach-agent/core/tools'
import { createDomPageHost } from '../dom-host'
const ctx = { sessionId: 's', signal: new AbortController().signal } as ToolContext
describe('read_page host', () => {
  beforeEach(() => { document.body.innerHTML = '' })
  it('filters values and hidden content while keeping a closed-details summary', async () => {
    document.body.innerHTML = `<p>visible long text</p><p style="display:none">display secret</p><p style="visibility:collapse">collapse secret</p><input value="private"><script>bad</script><details><summary>Summary</summary><p>details secret</p></details>`
    const result = await createDomPageHost({ document, targetId: 't' }).readPage!({}, ctx)
    expect(result.text).toContain('visible long text Summary')
    expect(result.text).not.toMatch(/secret|private|bad/)
  })
  it('truncates text and rejects invalid direct limits', async () => {
    document.body.innerHTML = '<p>visible long text</p>'
    const host = createDomPageHost({ document, targetId: 't' })
    expect(await host.readPage!({ maxChars: 7 }, ctx)).toMatchObject({ text: 'visible', truncated: true })
    await expect(host.readPage!({ maxChars: 1.5 }, ctx)).rejects.toThrow('integer')
  })
})
