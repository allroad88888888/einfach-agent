import 'fake-indexeddb/auto'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { createBrowserAgent, type BrowserAgentClient } from '@einfach-agent/browser-agent'
import { BrowserAgentView } from './index'

const clients: BrowserAgentClient[] = []

afterEach(async () => { await Promise.all(clients.splice(0).map((client) => client.dispose())) })

async function configuredClient() {
  const client = await createBrowserAgent({ namespace: `chat-layout-${crypto.randomUUID()}` })
  clients.push(client)
  const connection = await client.saveConnection({ label: '测试连接', baseUrl: 'https://example.test/v1', models: ['test-model'], apiKey: 'secret' })
  const agent = await client.saveAgent({ name: '填写助手', instructions: '填写表单', connectionId: connection.id, model: 'test-model', toolNames: [], skillNames: [] })
  return { client, agent }
}

describe('chat-first layout', () => {
  it('keeps the selected session and draft while settings replaces the visible view', async () => {
    const { client, agent } = await configuredClient()
    render(<BrowserAgentView client={client} />)
    fireEvent.click(screen.getByRole('button', { name: '新建会话' }))
    fireEvent.change(screen.getByLabelText('使用 Agent'), { target: { value: agent.id } })
    fireEvent.click(screen.getByRole('button', { name: '创建会话' }))
    await screen.findByText('准备好了')
    fireEvent.change(screen.getByLabelText('消息'), { target: { value: '保留这段草稿' } })

    fireEvent.click(screen.getByRole('button', { name: '打开设置' }))
    await waitFor(() => expect(screen.getByRole('heading', { name: '设置' })).toHaveFocus())
    expect(screen.queryByRole('textbox', { name: '消息' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /返回对话/ }))

    await waitFor(() => expect(screen.getByRole('button', { name: '打开设置' })).toHaveFocus())
    expect(screen.getByLabelText('消息')).toHaveValue('保留这段草稿')
    expect(screen.getByRole('region', { name: '当前会话' })).toBeInTheDocument()
  })

  it('returns from settings with Escape without installing a global handler', async () => {
    const { client } = await configuredClient()
    render(<BrowserAgentView client={client} />)
    fireEvent.click(screen.getByRole('button', { name: '打开设置' }))
    fireEvent.keyDown(screen.getByRole('heading', { name: '设置' }), { key: 'Escape' })
    await waitFor(() => expect(screen.getByRole('button', { name: '打开设置' })).toHaveFocus())
  })
})
