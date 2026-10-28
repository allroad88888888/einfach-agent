import 'fake-indexeddb/auto'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBrowserAgent, type BrowserAgentClient } from '@einfach-agent/browser-agent'
import { BrowserAgentView } from '../index'

const clients: BrowserAgentClient[] = []
afterEach(async () => { await Promise.all(clients.splice(0).map((client) => client.dispose())) })

async function setup() {
  const client = await createBrowserAgent({ namespace: `ui-files-${crypto.randomUUID()}`, fetch: async () => Response.json({ choices: [{ message: { role: 'assistant', content: '已读取附件' }, finish_reason: 'stop' }] }) })
  clients.push(client)
  const connection = await client.saveConnection({ label: '测试', baseUrl: 'https://example.test/v1', models: ['test'], apiKey: 'test' })
  const agent = await client.saveAgent({ name: '附件助手', instructions: '测试', connectionId: connection.id, model: 'test', toolNames: [], skillNames: [] })
  const sessionId = await client.createSession(agent.id)
  render(<BrowserAgentView client={client} />)
  return { client, agent, sessionId }
}

function attach(name = '数据.csv', text = '城市,数量\n上海,12') {
  fireEvent.change(screen.getByLabelText('选择附件'), { target: { files: [new File([text], name)] } })
}

describe('attachment composer', () => {
  it('accepts file-only messages, shows readable cards, and restores files on undo', async () => {
    await setup()
    expect(screen.getByRole('button', { name: '添加附件' })).toBeEnabled()
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
    attach()
    expect(screen.getByLabelText('待发送附件')).toHaveTextContent('数据.csv')
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await screen.findByText('已读取附件')
    expect(screen.queryByLabelText('待发送附件')).not.toBeInTheDocument()
    const timeline = screen.getByLabelText('消息记录')
    expect(timeline).toHaveTextContent('数据.csv')
    expect(timeline).not.toHaveTextContent('"attachment"')
    fireEvent.click(within(timeline).getByRole('button', { name: /撤销此消息/ }))
    expect(await screen.findByLabelText('待发送附件')).toHaveTextContent('数据.csv')
    expect(screen.getByLabelText('消息')).toHaveValue('')
    expect(screen.getByLabelText('消息')).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: '移除附件 数据.csv' }))
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
  })

  it('keeps drafts isolated between sessions and preserves files on rejection', async () => {
    const { client, agent, sessionId } = await setup()
    attach()
    fireEvent.change(screen.getByLabelText('消息'), { target: { value: '请填写' } })
    let other = ''
    await act(async () => { other = await client.createSession(agent.id) })
    expect(screen.queryByLabelText('待发送附件')).not.toBeInTheDocument()
    attach('配置.json', '{"city":"上海"}')
    act(() => { client.core.selectSession(sessionId) })
    expect(screen.getByLabelText('待发送附件')).toHaveTextContent('数据.csv')
    expect(screen.getByLabelText('待发送附件')).not.toHaveTextContent('配置.json')
    const send = vi.spyOn(client.core, 'sendMessage').mockResolvedValue({ accepted: false, status: 'rejected', reason: 'prepare_failed', error: '读取失败，请重试' })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await screen.findByText('读取失败，请重试')
    expect(screen.getByLabelText('消息')).toHaveValue('请填写')
    expect(screen.getByLabelText('待发送附件')).toHaveTextContent('数据.csv')
    expect(send).toHaveBeenCalledTimes(1)
    act(() => { client.core.selectSession(other) })
    expect(screen.getByLabelText('待发送附件')).toHaveTextContent('配置.json')
  })

  it('rejects unsupported files without losing selection and respects IME Enter', async () => {
    const { client } = await setup()
    attach()
    attach('文档.docx')
    expect(screen.getByRole('status')).toHaveTextContent('暂不支持')
    expect(screen.getByLabelText('待发送附件').querySelectorAll('li')).toHaveLength(1)
    expect(screen.getByLabelText('选择附件')).toHaveValue('')
    const send = vi.spyOn(client.core, 'sendMessage')
    fireEvent.keyDown(screen.getByLabelText('消息'), { key: 'Enter', isComposing: true, keyCode: 229 })
    expect(send).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByLabelText('消息'), { key: 'Enter', shiftKey: true })
    expect(send).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByLabelText('消息'), { key: 'Enter' })
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
  })
})
