import { afterEach, describe, expect, it } from 'vitest'
import { acquireNamespaceOwner } from './namespaceOwner'

const original = Object.getOwnPropertyDescriptor(Navigator.prototype, 'locks')
afterEach(() => {
  if (original) Object.defineProperty(Navigator.prototype, 'locks', original)
  else delete (Navigator.prototype as { locks?: unknown }).locks
})

describe('namespace ownership', () => {
  it('propagates lock-manager failure and permits a later retry', async () => {
    Object.defineProperty(Navigator.prototype, 'locks', { configurable: true, get: () => ({ request: () => Promise.reject(new Error('lock service failed')) }) })
    await expect(acquireNamespaceOwner('retry')).rejects.toThrow('lock service failed')

    Object.defineProperty(Navigator.prototype, 'locks', { configurable: true, get: () => ({
      request: async (_name: string, _options: unknown, callback: (lock: object) => Promise<void>) => callback({}),
    }) })
    const owner = await acquireNamespaceOwner('retry')
    await owner.release()
  })

  it('rejects a second realm while a shared browser lock is held', async () => {
    let held = false
    Object.defineProperty(Navigator.prototype, 'locks', { configurable: true, get: () => ({
      request: async (_name: string, _options: unknown, callback: (lock: object | null) => Promise<void>) => {
        if (held) return callback(null)
        held = true
        try { await callback({}) } finally { held = false }
      },
    }) })
    const first = await acquireNamespaceOwner('shared')
    await expect(acquireNamespaceOwner('shared')).rejects.toThrow('already has an owner')
    await first.release()
    const recovered = await acquireNamespaceOwner('shared')
    await recovered.release()
  })
})
