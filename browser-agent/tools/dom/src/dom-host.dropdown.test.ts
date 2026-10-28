import { beforeEach, describe, expect, it } from 'vitest'
import { createDomToolsHost } from './dom-host'
import type { PageCallContext } from './types'

const ctx = (signal = new AbortController().signal): PageCallContext => ({ sessionId: 'dropdown', signal })

describe('DOM host custom dropdown', () => {
  beforeEach(() => { document.body.innerHTML = '' })

  it('expands, searches, selects a body popup candidate, and reads the display value', async () => {
    document.body.innerHTML = '<div id="control" tabindex="0"><span id="display">请选择</span></div><input id="search">'
    const control = document.querySelector('#control')!; const search = document.querySelector('#search') as HTMLInputElement
    const options = ['功能建议', '安全漏洞', '数据问题']
    const render = (filter = '') => {
      document.querySelector('#popup')?.remove(); const popup = document.createElement('div'); popup.id = 'popup'
      for (const label of options.filter((item) => item.includes(filter))) { const option = document.createElement('span'); option.textContent = label; option.addEventListener('click', () => { document.querySelector('#display')!.textContent = label; popup.remove() }); popup.append(option) }
      document.body.append(popup)
    }
    control.addEventListener('click', () => setTimeout(() => render(search.value), 5)); search.addEventListener('input', () => render(search.value))
    const host = createDomToolsHost({ document, targetId: 'tab', documentId: 'doc' })
    const initial = await host.readDom({ selector: '#control' }, ctx()); await host.clickDom({ page: initial.page, ref: initial.nodes[0]!.ref }, ctx())
    const popup = await host.waitForDom({ page: initial.page, text: '功能建议', timeoutMs: 200 }, ctx()); expect(popup.nodes.some((node) => node.text === '功能建议')).toBe(true)
    const searchNode = (await host.readDom({ page: initial.page, selector: '#search' }, ctx())).nodes[0]!
    await host.typeDom({ page: initial.page, ref: searchNode.ref, text: '安全' }, ctx())
    const candidate = (await host.readDom({ page: initial.page, selector: '#popup span', text: '安全漏洞' }, ctx())).nodes[0]!
    await host.clickDom({ page: initial.page, ref: candidate.ref }, ctx())
    const selected = await host.readDom({ page: initial.page, selector: '#display' }, ctx())
    expect(selected.nodes[0]?.text).toBe('安全漏洞'); expect(selected.nodes[0]?.value).toBeUndefined()
  })

  it('keeps same-name candidates as distinct exact refs', async () => {
    document.body.innerHTML = '<div><span>重复</span><span>重复</span></div>'
    const host = createDomToolsHost({ document, targetId: 'tab' }); const found = await host.readDom({ selector: 'span', text: '重复' }, ctx())
    expect(found.nodes).toHaveLength(2); expect(found.nodes[0]!.ref).not.toBe(found.nodes[1]!.ref)
  })
})
