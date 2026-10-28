import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { itemsAtom, runAtom } from '@einfach-agent/core'
import { createBrowserAgent } from './client'
import { addTextAttachments, restoreTextAttachmentDraft } from './textAttachments'

const clients: Array<Awaited<ReturnType<typeof createBrowserAgent>>> = []
afterEach(async () => { await Promise.all(clients.splice(0).map((client) => client.dispose())) })

describe('browser attachment model and persistence boundary', () => {
  it('sends actual file contents and names, then restores them after reload and undo', async () => {
    const requests: unknown[] = []
    const namespace = `attachments-${crypto.randomUUID()}`
    const fetchImpl: typeof fetch = async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)))
      return Response.json({ choices: [{ message: { role: 'assistant', content: '收到 CSV' }, finish_reason: 'stop' }] })
    }
    const client = await createBrowserAgent({ namespace, fetch: fetchImpl })
    clients.push(client)
    const connection = await client.saveConnection({ label: '测试', baseUrl: 'https://example.test/v1', models: ['test'], apiKey: 'test' })
    const agent = await client.saveAgent({ name: '附件助手', instructions: '读附件', connectionId: connection.id, model: 'test', toolNames: [], skillNames: [] })
    const sessionId = await client.createSession(agent.id)
    const files = addTextAttachments([], [new File(['city,count\n上海,12'], '数据.csv')])
    expect((await client.core.sendMessage({ text: '', files }, { sessionId })).accepted).toBe(true)
    await expect.poll(() => client.core.sessionAtomScope(sessionId).getter(runAtom)?.status).toBe('done')
    expect(requests[0]).toMatchObject({ messages: expect.arrayContaining([{ role: 'user', content: '[附件 "数据.csv"]\ncity,count\n上海,12\n[附件结束]' }]) })
    const original = client.core.sessionAtomScope(sessionId).getter(itemsAtom)[0]
    expect(original.item).toMatchObject({ role: 'user', content: [{ type: 'text', text: 'city,count\n上海,12', attachment: { name: '数据.csv' } }] })
    await client.dispose()
    clients.splice(clients.indexOf(client), 1)
    const restored = await createBrowserAgent({ namespace, fetch: fetchImpl })
    clients.push(restored)
    const user = restored.core.sessionAtomScope(sessionId).getter(itemsAtom)[0]
    expect(user).toEqual(original)
    expect(restored.core.retractTurn(user.id, sessionId).ok).toBe(true)
    if (user.item.role !== 'user') throw new Error('Missing user turn')
    const draft = restoreTextAttachmentDraft(user.item.content)
    expect(draft.text).toBe('')
    expect(draft.files[0].name).toBe('数据.csv')
    expect((await restored.core.sendMessage(draft, { sessionId })).accepted).toBe(true)
    await expect.poll(() => restored.core.sessionAtomScope(sessionId).getter(runAtom)?.status).toBe('done')
    expect(requests).toHaveLength(2)
    expect(requests[1]).toMatchObject({ messages: expect.arrayContaining([{ role: 'user', content: '[附件 "数据.csv"]\ncity,count\n上海,12\n[附件结束]' }]) })
  })
})
