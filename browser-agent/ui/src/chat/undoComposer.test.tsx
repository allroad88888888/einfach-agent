import 'fake-indexeddb/auto'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { itemsAtom } from '@einfach-agent/core'
import { createBrowserAgent, type BrowserAgentClient } from '@einfach-agent/browser-agent'
import { BrowserAgentView } from '../index'

const clients: BrowserAgentClient[] = []

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.dispose()))
})

describe('conversation undo composer', () => {
  it('refills exact text, removes the sent turns, and leaves no redo entry', async () => {
    let requests = 0
    const client = await createBrowserAgent({
      namespace: `ui-undo-redo-${crypto.randomUUID()}`,
      fetch: async () => {
        requests++
        return new Response(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: `已有结果 ${requests}` }, finish_reason: 'stop' }],
        }), { headers: { 'content-type': 'application/json' } })
      },
    })
    clients.push(client)
    const connection = await client.saveConnection({ label: '测试连接', baseUrl: 'https://example.test/v1', models: ['test-model'], apiKey: 'secret' })
    const agent = await client.saveAgent({ name: '测试助手', instructions: '测试', connectionId: connection.id, model: 'test-model', toolNames: [], skillNames: [] })
    const sessionId = await client.createSession(agent.id)

    render(<BrowserAgentView client={client} />)
    const first = '第一行\n第二行 🌏'
    await send(first, '已有结果 1')
    await send('第二轮', '已有结果 2')

    const firstMessage = within(screen.getByLabelText('消息记录')).getByText('第一行 第二行 🌏').closest('article')
    expect(firstMessage).toBeTruthy()
    fireEvent.click(within(firstMessage!).getByRole('button', { name: /撤销此消息及后续对话/ }))

    const composer = screen.getByLabelText('消息') as HTMLTextAreaElement
    await waitFor(() => expect(composer.value).toBe(first))
    expect(composer).toHaveFocus()
    expect(client.core.sessionAtomScope(sessionId).getter(itemsAtom)).toEqual([])
    expect(screen.getByLabelText('消息记录').querySelector('.bav-message')).toBeNull()
    expect(screen.queryByRole('button', { name: '重做' })).not.toBeInTheDocument()
    expect(requests).toBe(2)
  })

  it('stops an in-flight run before enabling, refilling and focusing the composer', async () => {
    const user = userEvent.setup()
    const { client, sessionId } = await configuredClient((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    }))
    render(<BrowserAgentView client={client} />)
    const original = '运行中的原话\n含 Unicode：撤销 ↩'
    fireEvent.change(screen.getByLabelText('消息'), { target: { value: original } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))

    const composer = screen.getByLabelText('消息') as HTMLTextAreaElement
    await waitFor(() => expect(composer).toBeDisabled())
    const undo = await screen.findByRole('button', { name: /当前运行会先停止/ })
    await user.click(undo)

    await waitFor(() => expect(composer).toBeEnabled())
    expect(composer.value).toBe(original)
    expect(composer).toHaveFocus()
    expect(client.core.sessionAtomScope(sessionId).getter(itemsAtom)).toEqual([])
  })

  it('focuses again when consecutive undo sources have the same text, and a refusal preserves the draft', async () => {
    const user = userEvent.setup()
    let responseNumber = 0
    const { client, sessionId } = await configuredClient(async () => new Response(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: `完成 ${++responseNumber}` }, finish_reason: 'stop' }],
    }), { headers: { 'content-type': 'application/json' } }))
    render(<BrowserAgentView client={client} />)
    await send('相同原话', '完成 1')
    await send('相同原话', '完成 2')

    let undoButtons = screen.getAllByRole('button', { name: /撤销此消息及后续对话/ })
    undoButtons[1].focus()
    expect(undoButtons[1]).toHaveFocus()
    await user.click(undoButtons[1])
    const composer = screen.getByLabelText('消息') as HTMLTextAreaElement
    await waitFor(() => expect(composer).toHaveFocus())
    expect(composer.value).toBe('相同原话')
    await send('相同原话', '完成 3')

    undoButtons = screen.getAllByRole('button', { name: /撤销此消息及后续对话/ })
    undoButtons[0].focus()
    expect(undoButtons[0]).toHaveFocus()
    await user.click(undoButtons[0])
    await waitFor(() => expect(composer).toHaveFocus())
    expect(composer.value).toBe('相同原话')

    fireEvent.change(composer, { target: { value: '拒绝时保留' } })
    vi.spyOn(client.core, 'retractTurn').mockReturnValue({ ok: false, refusal: 'turn_not_retractable', entries: 0, stoppedRun: false })
    await send('可撤销记录', '完成 4')
    fireEvent.change(composer, { target: { value: '拒绝时保留' } })
    await user.click(screen.getAllByRole('button', { name: /撤销此消息及后续对话/ })[0])
    expect(composer.value).toBe('拒绝时保留')
  })
})

async function configuredClient(fetchImpl: typeof globalThis.fetch) {
  const client = await createBrowserAgent({ namespace: `ui-undo-extra-${crypto.randomUUID()}`, fetch: fetchImpl })
  clients.push(client)
  const connection = await client.saveConnection({ label: '测试连接', baseUrl: 'https://example.test/v1', models: ['test-model'], apiKey: 'secret' })
  const agent = await client.saveAgent({ name: '测试助手', instructions: '测试', connectionId: connection.id, model: 'test-model', toolNames: [], skillNames: [] })
  return { client, sessionId: await client.createSession(agent.id) }
}

async function send(text: string, answer: string) {
  const composer = screen.getByLabelText('消息')
  fireEvent.change(composer, { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: '发送' }))
  await screen.findByText(answer)
}
