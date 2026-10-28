import 'fake-indexeddb/auto'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { createBrowserAgent, type BrowserAgentClient } from '@einfach-agent/browser-agent'
import { activeSessionIdAtom, itemsAtom, runAtom, sessionsAtom } from '@einfach-agent/core'
import { BrowserAgentView } from '../index'

const clients = new Set<BrowserAgentClient>()
afterEach(async () => { cleanup(); await Promise.all([...clients].map((client) => client.dispose())); clients.clear() })

const question = {
  title: '补充填写要求',
  questions: [
    { id: 'title', text: '填写标题', type: 'text', required: true },
    { id: 'mode', text: '选择方式', type: 'single-choice', options: ['预览', '执行'], required: true },
    { id: 'parts', text: '选择范围', type: 'multi-choice', options: ['基本信息', '详情'], required: true },
    { id: 'submit', text: '现在提交吗', type: 'confirm', required: true },
  ],
}
const answers = { title: '测试标题', mode: '预览', parts: ['基本信息', '详情'], submit: false }
interface ModelRequest {
  tools?: Array<{ function?: { name?: string } }>
  messages: Array<{ role: string; content?: unknown; tool_call_id?: string }>
}

it('enables the existing question tool, restores its paused run, and resumes with all four answer types', async () => {
  const namespace = `ask-ui-${crypto.randomUUID()}`
  let calls = 0
  let receivedAnswers = false
  const fetchImpl: typeof fetch = async (_input, init) => {
    if (++calls > 4) throw new Error('Unexpected extra model request')
    const request = JSON.parse(String(init?.body)) as ModelRequest
    const receipt = request.messages.find((message) => message.role === 'tool' && message.tool_call_id === 'ask-call')
    if (receipt) {
      expect(JSON.parse(String(receipt.content))).toEqual({ answers })
      receivedAnswers = true
      return response({ role: 'assistant', content: '已根据你的答复继续，保留为预览。' })
    }
    const loaded = request.tools?.some((tool) => tool.function?.name === 'ask_user_question')
    return response({ role: 'assistant', content: null, tool_calls: [{
      id: loaded ? 'ask-call' : 'schema-call', type: 'function',
      function: { name: loaded ? 'ask_user_question' : 'request_tool_schema', arguments: JSON.stringify(loaded ? question : { toolName: 'ask_user_question', reason: 'Collect missing user decisions' }) },
    }] })
  }
  async function open() {
    const client = await createBrowserAgent({ namespace, fetch: fetchImpl })
    clients.add(client)
    return client
  }
  const client = await open()
  const catalog = client.core.tools.list().map((tool) => tool.name)
  expect(catalog).toContain('ask_user_question')
  expect(catalog).not.toContain('browser_action')
  expect(catalog).not.toContain('save_file')
  const connection = await client.saveConnection({ label: '测试连接', baseUrl: 'https://example.test/v1', models: ['test'], apiKey: 'test-only' })
  const agent = await client.saveAgent({ name: '提问助手', instructions: '缺少信息时提问', connectionId: connection.id, model: 'test', toolNames: [], skillNames: [] })
  const otherId = await client.createSession(agent.id)
  const view = render(<BrowserAgentView client={client} />)
  fireEvent.click(screen.getByRole('button', { name: '打开设置' }))
  fireEvent.click(screen.getByRole('button', { name: /提问助手.*r1/ }))
  fireEvent.click(screen.getByText('工具能力').closest('summary')!)
  fireEvent.click(screen.getByRole('checkbox', { name: /ask_user_question/ }))
  fireEvent.click(screen.getByRole('button', { name: '保存 Agent' }))
  await screen.findByText(/Agent 已保存/)
  expect(client.getSnapshot().agents[0]?.toolNames).toEqual(['ask_user_question'])
  fireEvent.click(screen.getByRole('button', { name: /返回对话/ }))
  fireEvent.click(screen.getByRole('button', { name: '新建会话' }))
  fireEvent.change(screen.getByLabelText('使用 Agent'), { target: { value: agent.id } })
  fireEvent.click(screen.getByRole('button', { name: '创建会话' }))
  await screen.findByText('准备好了')
  await waitFor(() => expect(client.core.rootStore.getter(activeSessionIdAtom)).not.toBe(otherId))
  const id = client.core.rootStore.getter(activeSessionIdAtom)
  fireEvent.change(screen.getByLabelText('消息'), { target: { value: '开始填写，先问我缺失信息' } })
  fireEvent.click(screen.getByRole('button', { name: '发送' }))
  await screen.findByRole('heading', { name: '补充填写要求' })
  expect(client.core.sessionAtomScope(id).getter(runAtom)?.status).toBe('waiting_user')
  expect(screen.getByRole('button', { name: '继续' })).toBeDisabled()
  expect(client.core.sessionAtomScope(otherId).getter(itemsAtom)).toEqual([])

  view.unmount()
  await client.dispose({ preserveRecovery: true }); clients.delete(client)
  const restored = await open()
  expect(Object.keys(restored.core.rootStore.getter(sessionsAtom))).toContain(id)
  expect(restored.core.sessionAtomScope(id).getter(runAtom)?.status).toBe('waiting_user')
  render(<BrowserAgentView client={restored} />)
  fireEvent.click(screen.getByRole('button', { name: '打开历史记录' }))
  fireEvent.click(screen.getByRole('button', { name: /打开会话：开始填写/ }))
  await screen.findByRole('heading', { name: '补充填写要求' })
  fireEvent.change(screen.getByRole('textbox', { name: /填写标题/ }), { target: { value: answers.title } })
  fireEvent.click(screen.getByRole('button', { name: '预览' }))
  const parts = within(screen.getByRole('group', { name: /选择范围/ }))
  fireEvent.click(parts.getByRole('button', { name: '基本信息' }))
  fireEvent.click(parts.getByRole('button', { name: '详情' }))
  fireEvent.click(screen.getByRole('button', { name: '否' }))
  expect(screen.getByRole('button', { name: '继续' })).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: '继续' }))
  await screen.findByText('已根据你的答复继续，保留为预览。')
  await waitFor(() => expect(restored.core.sessionAtomScope(id).getter(runAtom)?.status).toBe('done'))
  expect(receivedAnswers).toBe(true)
  expect(restored.core.sessionAtomScope(otherId).getter(itemsAtom)).toEqual([])
  expect(screen.queryByRole('heading', { name: '补充填写要求' })).toBeNull()
})

function response(message: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }), { headers: { 'content-type': 'application/json' } })
}
