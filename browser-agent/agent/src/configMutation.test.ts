import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import { createBrowserAgentWithDependencies } from './client'
import type { StoredConfig } from './configStore'

describe('configuration mutation durability', () => {
  it('does not publish a failed write and keeps the mutation queue usable', async () => {
    const initial: StoredConfig = { version: 1, agents: [], skills: [], connections: [] }
    let fail = true
    let persisted = initial
    const save = vi.fn(async (_name: string, next: StoredConfig) => {
      if (fail) { fail = false; throw new Error('deterministic write failure') }
      persisted = structuredClone(next)
    })
    const client = await createBrowserAgentWithDependencies(
      { namespace: `write-failure-${crypto.randomUUID()}` },
      { loadConfig: async () => structuredClone(initial), saveConfig: save },
    )
    const before = client.getSnapshot()
    const listener = vi.fn()
    client.subscribe(listener)

    await expect(client.saveConnection({ label: 'failed', baseUrl: 'https://failed.example', models: ['m'], apiKey: 'secret' }))
      .rejects.toThrow('deterministic write failure')
    expect(client.getSnapshot()).toBe(before)
    expect(client.getSnapshot().connections).toEqual([])
    expect(listener).not.toHaveBeenCalled()

    await client.saveConnection({ label: 'saved', baseUrl: 'https://saved.example', models: ['m'], apiKey: 'secret' })
    expect(client.getSnapshot()).not.toBe(before)
    expect(client.getSnapshot().connections).toHaveLength(1)
    expect(persisted.connections[0]?.label).toBe('saved')
    expect(listener).toHaveBeenCalledOnce()
    await client.dispose()
  })
})
