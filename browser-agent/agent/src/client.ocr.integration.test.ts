import 'fake-indexeddb/auto'
import { Blob as NodeBlob, File as NodeFile } from 'node:buffer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { itemsAtom, runAtom } from '@einfach-agent/core'
import { createBrowserAgent } from './client'
import { createAttachmentStore } from './attachmentStore'
import { addTextAttachments, restoreTextAttachmentDraft } from './textAttachments'

const clients: Array<Awaited<ReturnType<typeof createBrowserAgent>>> = []
// fake-indexeddb uses structuredClone, which clones native Blob but not jsdom's Blob shim.
beforeEach(() => {
  vi.stubGlobal('Blob', NodeBlob); vi.stubGlobal('File', NodeFile)
  // jsdom FormData rejects native blobs; transport is mocked in this persistence test.
  vi.stubGlobal('FormData', class { fields = new Map(); append(name: string, value: unknown) { this.fields.set(name, value) } get(name: string) { return this.fields.get(name) } })
})
afterEach(async () => { await Promise.all(clients.splice(0).map((client) => client.dispose())); vi.unstubAllGlobals() })

async function profile(client: Awaited<ReturnType<typeof createBrowserAgent>>, tools = ['paddle_ocr']) {
  const connection = await client.saveConnection({ label: '测试', baseUrl: 'https://model.test/v1', models: ['test'], apiKey: 'model-only' })
  return client.saveAgent({ name: '识别助手', instructions: '读附件', connectionId: connection.id, model: 'test', toolNames: tools, skillNames: [] })
}

// These integration tests perform asynchronous persistence and model runs on shared CI workers.
vi.setConfig({ testTimeout: 30_000 })

describe('OCR attachments through the browser runtime', () => {
  it('keeps PDF bytes session-scoped through reload and undo, and sends them only to OCR', async () => {
    const namespace = `ocr-files-${crypto.randomUUID()}`
    const requests: Array<{ body: string; authorization: string | null }> = []
    let attachmentId = ''
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = String(init?.body)
      requests.push({ body, authorization: new Headers(init?.headers).get('authorization') })
      const payload = JSON.parse(body)
      attachmentId = body.match(/attachmentId=(file-[\w-]+)/)?.[1] ?? attachmentId
      const message = payload.messages.some((entry: { role: string; content?: string }) => entry.role === 'tool' && entry.content && JSON.parse(entry.content).state === 'done')
        ? { role: 'assistant', content: '合同金额 123 元' }
        : { role: 'assistant', content: null, tool_calls: [{ id: `ocr-${requests.length}`, type: 'function', function: { name: 'paddle_ocr', arguments: JSON.stringify({ attachmentId }) } }] }
      return Response.json({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] })
    }
    const ocrFetch = vi.fn<typeof fetch>(async (input, init) => {
      if (init?.method === 'POST') {
        expect(new Headers(init.headers).get('authorization')).toBe('bearer ocr-only')
        expect((init.body as FormData).get('file')).toBeTruthy()
        return Response.json({ data: { jobId: 'test-job' } })
      }
      if (String(input).includes('/ocr/jobs/')) return Response.json({ data: { state: 'done', resultUrl: { jsonUrl: 'https://result.test/pages.jsonl' } } })
      expect(new Headers(init?.headers).has('authorization')).toBe(false)
      return new Response(JSON.stringify({ result: { ocrResults: [{ prunedResult: { rec_texts: ['合同金额 123 元'] } }] } }))
    })
    const client = await createBrowserAgent({ namespace, fetch: fetchImpl, ocrFetch }); clients.push(client)
    const agent = await profile(client)
    await client.saveOcrToken('ocr-only')
    const sessionId = await client.createSession(agent.id)
    const files = addTextAttachments([], [new File(['%PDF-secret-binary'], '合同.pdf')])
    expect((await client.core.sendMessage({ text: '识别合同', files }, { sessionId })).accepted).toBe(true)
    await expect.poll(() => client.core.sessionAtomScope(sessionId).getter(runAtom)?.status).toBe('done')
    expect(ocrFetch.mock.calls, JSON.stringify(client.core.sessionAtomScope(sessionId).getter(itemsAtom))).toHaveLength(3)
    expect(requests).toHaveLength(3)
    expect(requests.every((request) => request.authorization === 'Bearer model-only' && !request.body.includes('ocr-only') && !request.body.includes('%PDF-secret-binary'))).toBe(true)
    expect(requests.at(-1)?.body).toContain('合同金额 123 元')
    expect(JSON.stringify(client.getSnapshot())).not.toContain('ocr-only')
    const original = client.core.sessionAtomScope(sessionId).getter(itemsAtom)[0]
    const store = createAttachmentStore(namespace)
    expect(await (await store.get(sessionId, attachmentId)).data.text()).toBe('%PDF-secret-binary')
    await client.dispose(); clients.splice(clients.indexOf(client), 1)

    const restored = await createBrowserAgent({ namespace, fetch: fetchImpl, ocrFetch }); clients.push(restored)
    expect(restored.getSnapshot().ocr?.credentialConfigured).toBe(true)
    const user = restored.core.sessionAtomScope(sessionId).getter(itemsAtom)[0]
    expect(user).toEqual(original)
    expect(restored.core.retractTurn(user.id, sessionId).ok).toBe(true)
    if (user.item.role !== 'user') throw new Error('Missing user turn')
    const draft = restoreTextAttachmentDraft(user.item.content)
    expect(draft.files[0].data).toEqual({ fileId: attachmentId })
    const otherSession = await restored.createSession(agent.id)
    await expect(store.get(otherSession, attachmentId)).rejects.toThrow('当前会话找不到')
    expect(await restored.core.sendMessage(draft, { sessionId: otherSession })).toMatchObject({ accepted: false, reason: 'prepare_failed' })
    expect((await restored.core.sendMessage(draft, { sessionId })).accepted).toBe(true)
    await expect.poll(() => restored.core.sessionAtomScope(sessionId).getter(runAtom)?.status).toBe('done')
    expect(ocrFetch).toHaveBeenCalledTimes(6)
    await restored.deleteSessions([sessionId])
    await expect(store.get(sessionId, attachmentId)).rejects.toThrow('当前会话找不到')
    await restored.saveOcrToken('')
    expect(restored.getSnapshot().ocr?.credentialConfigured).toBe(false)
  })

  it('rejects PDF sends before committing when credentials or the session capability are missing', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
    const client = await createBrowserAgent({ namespace: `ocr-gates-${crypto.randomUUID()}`, fetch: fetchImpl }); clients.push(client)
    const agent = await profile(client, [])
    const sessionId = await client.createSession(agent.id)
    const draft = { text: '', files: addTextAttachments([], [new File(['%PDF'], '合同.pdf')]) }
    expect(await client.core.sendMessage(draft, { sessionId })).toMatchObject({ accepted: false, reason: 'prepare_failed', error: expect.stringContaining('Token') })
    await client.saveOcrToken('ocr-only')
    expect(await client.core.sendMessage(draft, { sessionId })).toMatchObject({ accepted: false, reason: 'prepare_failed', error: expect.stringContaining('未启用 paddle_ocr') })
    expect(client.core.sessionAtomScope(sessionId).getter(itemsAtom)).toEqual([])
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
