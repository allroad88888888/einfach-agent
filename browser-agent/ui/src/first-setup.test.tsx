import 'fake-indexeddb/auto'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { createBrowserAgent, type BrowserAgentClient } from '@einfach-agent/browser-agent'
import { BrowserAgentView } from './index'

let client: BrowserAgentClient | undefined
afterEach(async () => { await client?.dispose(); client = undefined })

it('completes first setup with the selected model and keeps the API Key out of the UI', async () => {
  const requests: Array<{ url: string; authorization: string | null; model: string }> = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers)
    const body = JSON.parse(String(init?.body)) as { model: string }
    requests.push({ url: String(input), authorization: headers.get('authorization'), model: body.model })
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '首配成功' }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } })
  }
  client = await createBrowserAgent({ namespace: `ui-first-setup-${crypto.randomUUID()}`, fetch: fetchImpl })
  render(<BrowserAgentView client={client} />)

  fireEvent.click(screen.getByRole('button', { name: '配置模型与 API Key' }))
  expect((screen.getByLabelText('连接名称') as HTMLInputElement).value).toBe('DeepSeek V4.1 Flash')
  expect((screen.getByLabelText('接口地址') as HTMLInputElement).value).toBe('https://api.deepseek.com/v1')
  expect((screen.getByLabelText('模型 ID 列表') as HTMLTextAreaElement).value).toBe('deepseek-flash')
  expect((screen.getByLabelText('API Key') as HTMLInputElement).value).toBe('')
  fireEvent.change(screen.getByLabelText('连接名称'), { target: { value: '首次连接' } })
  fireEvent.change(screen.getByLabelText('接口地址'), { target: { value: 'https://first-setup.test/v1' } })
  fireEvent.change(screen.getByLabelText('模型 ID 列表'), { target: { value: 'fast-model\nprecise-model' } })
  fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'first-setup-secret' } })
  fireEvent.click(screen.getByRole('button', { name: '保存模型连接' }))

  await screen.findByText('API Key 已配置；为安全起见不会回显。')
  expect(screen.queryByDisplayValue('first-setup-secret')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '下一步：创建 Agent' }))
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: '首次 Agent' } })
  fireEvent.change(screen.getByLabelText('工作说明'), { target: { value: '完成首次配置测试' } })
  expect((screen.getByLabelText('连接') as HTMLSelectElement).value).toBe(client.getSnapshot().connections[0]?.id)
  fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'precise-model' } })
  fireEvent.click(screen.getByRole('button', { name: '保存 Agent' }))

  await screen.findByText(/Agent 已保存/)
  fireEvent.click(screen.getByRole('button', { name: '回到对话并创建会话' }))
  fireEvent.click(screen.getByRole('button', { name: '新建会话' }))
  fireEvent.change(screen.getByLabelText('使用 Agent'), { target: { value: client.getSnapshot().agents[0]?.id } })
  fireEvent.click(screen.getByRole('button', { name: '创建会话' }))
  await screen.findByText('准备好了')
  fireEvent.change(screen.getByLabelText('消息'), { target: { value: '验证模型请求' } })
  fireEvent.click(screen.getByRole('button', { name: '发送' }))

  await screen.findByText('首配成功')
  await waitFor(() => expect(requests).toEqual([{
    url: 'https://first-setup.test/v1/chat/completions',
    authorization: 'Bearer first-setup-secret',
    model: 'precise-model',
  }]))
  expect(document.body.textContent).not.toContain('first-setup-secret')
})
