export interface NamespaceOwner { release(): Promise<void> }

const localOwners = new Set<string>()

/** Web Locks are released by the user agent when a tab/worker realm disappears. */
export async function acquireNamespaceOwner(namespace: string): Promise<NamespaceOwner> {
  const manager = globalThis.navigator?.locks
  if (manager) {
    let release!: () => void
    const released = new Promise<void>((resolve) => { release = resolve })
    let announce!: (acquired: boolean) => void
    let rejectAnnouncement!: (error: unknown) => void
    const announced = new Promise<boolean>((resolve, reject) => { announce = resolve; rejectAnnouncement = reject })
    const holding = manager.request(`einfach-browser-agent:${namespace}`, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
      announce(Boolean(lock))
      if (lock) await released
    }).catch((error) => { rejectAnnouncement(error); throw error })
    let acquired: boolean
    try { acquired = await announced } catch (error) { await holding.catch(() => undefined); throw error }
    if (!acquired) {
      await holding
      throw new Error(`Browser agent namespace already has an owner: ${namespace}`)
    }
    let done = false
    return { async release() { if (done) return; done = true; release(); await holding } }
  }

  // fake-indexeddb/jsdom has no cross-realm browser surface. Keep an explicit test-only
  // coordinator; real browsers without Web Locks fail closed instead of permitting two writers.
  if (!globalThis.navigator?.userAgent?.toLowerCase().includes('jsdom')) {
    throw new Error('Browser agent requires the Web Locks API for namespace ownership')
  }
  if (localOwners.has(namespace)) throw new Error(`Browser agent namespace already has an owner: ${namespace}`)
  localOwners.add(namespace)
  return { async release() { localOwners.delete(namespace) } }
}
