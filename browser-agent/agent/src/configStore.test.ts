import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { createBrowserAgent } from './client'

function writeRaw(name: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1)
    request.onupgradeneeded = () => request.result.createObjectStore('config')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      const tx = db.transaction('config', 'readwrite')
      tx.objectStore('config').put(value, 'root')
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onerror = () => { db.close(); reject(tx.error) }
    }
  })
}

describe('browser-agent persisted configuration boundary', () => {
  it('releases ownership when host tool registration throws', async () => {
    const namespace = `registration-failure-${crypto.randomUUID()}`
    await expect(createBrowserAgent({ namespace, registerTools() { throw new Error('registration failed') } }))
      .rejects.toThrow('registration failed')
    const retried = await createBrowserAgent({ namespace })
    await retried.dispose()
  })

  it.each([
    { version: 1, agents: 'bad', skills: [], connections: [] },
    { version: 1, agents: [], skills: [], connections: [{ id: 'c', label: 'x', baseUrl: 'javascript:x', models: ['m'], credentialConfigured: false }] },
    { version: 1, agents: [{ id: 'a', name: 'a', instructions: 'i', connectionId: 'missing', model: 'm', toolNames: [], skillNames: [], revision: 1 }], skills: [], connections: [] },
    { version: 2, agents: [], skills: [], connections: [] },
    { version: 1, agents: [], skills: [], connections: [
      { id: 'same', label: 'one', baseUrl: 'https://one.example', models: ['m'], credentialConfigured: false },
      { id: 'same', label: 'two', baseUrl: 'https://two.example', models: ['m'], credentialConfigured: false },
    ] },
    { version: 1, agents: [], skills: [
      { name: 'same', description: 'one', triggers: [], content: 'one', resources: {}, revision: 1 },
      { name: 'same', description: 'two', triggers: [], content: 'two', resources: {}, revision: 2 },
    ], connections: [] },
  ])('rejects corrupt/future data and releases ownership for retry', async (value) => {
    const namespace = `corrupt-${crypto.randomUUID()}`
    await writeRaw(`einfach-browser-agent-config:${namespace}`, value)
    await expect(createBrowserAgent({ namespace })).rejects.toThrow('corrupt')
    await expect(createBrowserAgent({ namespace })).rejects.toThrow('corrupt')
  })
})
