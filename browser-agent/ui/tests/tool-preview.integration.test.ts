import 'fake-indexeddb/auto'
import type { ToolContext } from '@einfach-agent/core/tools'
import { createBrowserAgent } from '@einfach-agent/browser-agent'
import { createApiToolsHost, registerApiTools } from '@einfach-agent/tools-browser-api'
import { createDomPageHost, registerPageTools } from '@einfach-agent/tools-browser-page'
import { createWindowNetworkHost, registerNetworkTools } from '@einfach-agent/tools-browser-network'
import { registerDomTools } from '@einfach-agent/tools-browser-dom'
import { runDomPreview } from './fixture-dom-preview.testFixtures'
import { createFixtureBusiness } from './fixture-business.testFixtures'
import { afterEach, expect, it, vi } from 'vitest'

let dispose: (() => Promise<void>) | undefined
afterEach(async () => { await dispose?.(); dispose = undefined })

it('assembles 21 visible tools against an isolated business iframe and executes the preview catalog', async () => {
  const iframe = document.createElement('iframe'); document.body.append(iframe)
  const business = iframe.contentDocument!
  business.body.innerHTML = `<main><h1>申请单</h1><input aria-label="姓名" value="Ada"><select aria-label="城市"><option value="">请选择</option><option value="shanghai">上海</option></select><select aria-label="异步团队"></select><table><caption>申请</caption><tr><th>姓名</th><th>状态</th></tr><tr><td>Ada</td><td>待审核</td></tr></table></main>`
  const host = createDomPageHost({ document: business, targetId: 'preview-frame', documentId: 'preview-document' })
  const networkHost = createWindowNetworkHost({ window: iframe.contentWindow!, targetId: 'preview-frame', documentId: 'preview-document' })
  const apiHost = createApiToolsHost([{ id: 'cities', label: '城市目录', description: '演示候选项', async query() { return { options: [{ label: '上海', value: 'shanghai' }] } } }], { isSourceAllowed: () => true })
  const client = await createBrowserAgent({ namespace: `preview-${crypto.randomUUID()}`, registerTools(registry) { registerPageTools(registry, host); registerApiTools(registry, apiHost); registerNetworkTools(registry, networkHost) } })
  dispose = async () => { networkHost.dispose(); await client.dispose() }
  const names = client.core.tools.list().map(({ name }) => name).sort()
  expect(names).toEqual(['ask_user_question', 'clear_fields', 'fill_fields', 'get_network_request', 'get_network_response', 'list_network_requests', 'list_options_sources', 'paddle_ocr', 'query_options', 'read_field_options', 'read_form', 'read_page', 'read_table', 'select_option', 'skill_read', 'skill_search', 'start_network_capture', 'stop_network_capture', 'validate_form', 'wait_for_field', 'wait_for_network_request'].sort())
  expect(iframe.contentDocument).not.toBe(document)

  const ctx = { sessionId: 'preview-session', signal: new AbortController().signal } as ToolContext
  const pageResult = await client.core.tools.run('read_page', {}, ctx)
  expect(pageResult).toMatchObject({ ok: true, data: { text: expect.stringContaining('申请单') } })
  const pageData = (pageResult as { data: { page: object; tables: { id: string }[] } }).data
  await expect(client.core.tools.run('read_table', { page: pageData.page, tableId: pageData.tables[0].id }, ctx)).resolves.toMatchObject({ ok: true, data: { rows: [['Ada', '待审核']] } })

  const form = await client.core.tools.run('read_form', {}, ctx) as { data: { page: object; fields: { id: string; label: string }[] } }
  const city = form.data.fields.find((field) => field.label === '城市')!
  const team = form.data.fields.find((field) => field.label === '异步团队')!
  await expect(client.core.tools.run('read_field_options', { page: form.data.page, fieldId: city.id }, ctx)).resolves.toMatchObject({ ok: true, data: { options: expect.arrayContaining([{ label: '上海', value: 'shanghai' }]) } })
  await expect(client.core.tools.run('select_option', { page: form.data.page, fieldId: city.id, value: 'shanghai' }, ctx)).resolves.toMatchObject({ ok: true })
  setTimeout(() => business.querySelectorAll('select')[1].append(new Option('平台', 'platform')), 10)
  await expect(client.core.tools.run('wait_for_field', { page: form.data.page, fieldId: team.id, condition: 'options', timeoutMs: 200 }, ctx)).resolves.toMatchObject({ ok: true })
  await expect(client.core.tools.run('clear_fields', { page: form.data.page, fieldIds: [city.id] }, ctx)).resolves.toMatchObject({ ok: true })
  await expect(client.core.tools.run('list_options_sources', {}, ctx)).resolves.toMatchObject({ ok: true, data: { sources: [{ id: 'cities', label: '城市目录', description: '演示候选项' }] } })
})

it('runs the visible custom dropdown demo through the real registry and host', async () => {
  const container = document.createElement('div')
  document.body.append(container)
  const business = await createFixtureBusiness(container, (window) => { window.fetch = vi.fn().mockResolvedValue(new Response('{"cities":[]}')) as typeof fetch })
  const client = await createBrowserAgent({ namespace: `dom-preview-${crypto.randomUUID()}`, registerTools(registry) { registerDomTools(registry, business.domHost) } })
  await expect(runDomPreview(client.core.tools, business)).resolves.toContain('回读显示值“安全漏洞”')
  expect(business.iframe.contentDocument?.querySelector('[data-ticket-value]')?.textContent).toBe('安全漏洞')
  await client.dispose(); business.dispose()
})
