import 'fake-indexeddb/auto'
import { itemsAtom, runAtom } from '@einfach-agent/core'
import { createBrowserAgent, type BrowserAgentClient } from '@einfach-agent/browser-agent'
import { createDomToolsHost, registerDomTools } from '@einfach-agent/tools-browser-dom'
import { afterEach, expect, it } from 'vitest'

const clients: BrowserAgentClient[] = []
afterEach(async () => { await Promise.all(clients.splice(0).map((client) => client.dispose())) })

it('gives the mock model DOM schemas and selects a plain async option through two isolated sessions', async () => {
  const first = await harness('first', '安全漏洞')
  const second = await harness('second', '权限异常')
  await Promise.all([first.run(), second.run()])
  if (first.value.textContent !== '安全漏洞') throw new Error(JSON.stringify(first.client.core.sessionAtomScope(first.sessionId).getter(itemsAtom).filter((item) => item.item.role === 'tool').map((item) => item.item.content)))
  expect(second.value.textContent).toBe('安全漏洞')
  expect(first.requests.flatMap((request) => request.tools)).toEqual(expect.arrayContaining(['read_dom', 'click_dom', 'wait_for_dom']))
  expect(second.requests.flatMap((request) => request.tools)).toEqual(expect.arrayContaining(['read_dom', 'click_dom', 'wait_for_dom']))
  expect(first.readbacks).toEqual([{ targetId: 'first', value: '安全漏洞' }])
  expect(second.readbacks).toEqual([{ targetId: 'second', value: '安全漏洞' }])
  expect(first.document.querySelector('[data-option="权限异常"]')).toBeNull()
  expect(second.document.querySelector('[data-option="权限异常"]')).not.toBeNull()
}, 15_000)

async function harness(namespace: string, extraOption: string) {
  const frame = window.document.createElement('iframe'); window.document.body.append(frame)
  const document = frame.contentDocument!; document.open(); document.write(`<main><h1>${namespace}</h1><section><div tabindex="0">选择工单类型</div><span data-value>尚未选择</span><div data-options hidden><span data-option="功能建议">功能建议</span><span data-option="安全漏洞">安全漏洞</span><span data-option="${extraOption}">${extraOption}</span></div></section></main>`); document.close()
  const trigger = document.querySelector<HTMLElement>('[tabindex]')!
  const options = document.querySelector<HTMLElement>('[data-options]')!
  const value = document.querySelector<HTMLElement>('[data-value]')!
  trigger.addEventListener('click', () => setTimeout(() => { options.hidden = false }, 10))
  options.addEventListener('click', (event) => { const option = (event.target as Element).closest('[data-option]'); if (option) value.textContent = option.textContent })
  const requests: Array<{ tools: string[] }> = []
  const readbacks: Array<{ targetId: string; value: string }> = []
  const host = createDomToolsHost({ document, targetId: namespace, documentId: `${namespace}-document` })
  const client = await createBrowserAgent({ namespace: `dom-model-${namespace}-${crypto.randomUUID()}`, fetch: model(requests, namespace, readbacks), registerTools(registry) { registerDomTools(registry, host) } })
  clients.push(client)
  const connection = await client.saveConnection({ label: namespace, baseUrl: 'https://fixture.invalid/v1', models: ['fixture'], apiKey: 'fixture' })
  const agent = await client.saveAgent({ name: namespace, instructions: 'Select 安全漏洞 by observing the DOM.', connectionId: connection.id, model: 'fixture', toolNames: ['read_dom', 'click_dom', 'wait_for_dom'], skillNames: [] })
  const sessionId = await client.createSession(agent.id)
  return { client, sessionId, document, value, requests, readbacks, async run() { await client.core.sendMessage('选择安全漏洞', { sessionId }); await waitForDone(client, sessionId) } }
}

function model(requests: Array<{ tools: string[] }>, expectedTargetId: string, readbacks: Array<{ targetId: string; value: string }>): typeof fetch {
  let turn = 0
  return async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { tools?: Array<{ function: { name: string } }>; messages: Array<{ role: string; content?: string }> }
    requests.push({ tools: (body.tools ?? []).map((tool) => tool.function.name) })
    const snapshots = body.messages.flatMap((message) => {
      if (message.role !== 'tool') return []
      try { const value = JSON.parse(message.content ?? '{}') as { page?: unknown; nodes?: Array<{ ref: string; parentRef?: string; name: string }> }; return value.page && value.nodes ? [value] : [] } catch { return [] }
    })
    const latest = snapshots.at(-1)
    const names = ['request_tool_schema', 'request_tool_schema', 'request_tool_schema', 'read_dom', 'click_dom', 'wait_for_dom', 'click_dom', 'read_dom']
    const name = names[turn]
    if (!name) {
      const final = snapshots.at(-1)
      const targetId = (final?.page as { targetId?: unknown } | undefined)?.targetId
      const value = final?.nodes?.find((node) => node.name === '安全漏洞')?.name
      if (targetId !== expectedTargetId || value !== '安全漏洞') throw new Error(`Model readback mismatch for ${expectedTargetId}`)
      readbacks.push({ targetId, value })
    }
    let args: object = {}
    if (name === 'request_tool_schema') args = { toolName: ['read_dom', 'click_dom', 'wait_for_dom'][turn] }
    if (name === 'read_dom') args = latest ? { page: latest.page, text: '安全漏洞' } : { text: '选择工单类型' }
    else if (name === 'wait_for_dom') args = { page: latest?.page, scopeRef: latest?.nodes?.find((node) => node.name.includes('选择工单类型'))?.parentRef, text: '安全漏洞', timeoutMs: 1000 }
    else if (name === 'click_dom') { const wanted = turn < 6 ? '选择工单类型' : '安全漏洞'; args = { page: latest?.page, ref: latest?.nodes?.find((node) => node.name === wanted)?.ref } }
    const message = name ? { role: 'assistant', content: null, tool_calls: [{ id: `call-${turn}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } : { role: 'assistant', content: `已从 ${expectedTargetId} 回读并确认安全漏洞。` }
    turn += 1
    return new Response(JSON.stringify({ choices: [{ message, finish_reason: name ? 'tool_calls' : 'stop' }] }), { headers: { 'content-type': 'application/json' } })
  }
}

async function waitForDone(client: BrowserAgentClient, sessionId: string): Promise<void> {
  const scope = client.core.sessionAtomScope(sessionId); const deadline = Date.now() + 10_000
  while (scope.getter(runAtom)?.status !== 'done') {
    const run = scope.getter(runAtom)
    if (run?.status === 'error' || run?.status === 'stopped' || run?.status === 'interrupted') throw new Error(run.error ?? `DOM model run ${run.status}`)
    if (Date.now() > deadline) throw new Error(`Timed out waiting for DOM model run (${run?.status})`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
