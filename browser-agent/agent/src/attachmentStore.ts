export interface StoredAttachment { id: string; sessionId: string; name: string; mimeType: string; byteSize: number; data: Blob }

/** Binary attachments have a session lifetime; undo/compaction never evicts their bytes. */
export function createAttachmentStore(namespace: string) {
  const name = `einfach-browser-agent-attachments:${namespace}`
  function open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1)
      request.onupgradeneeded = () => { const store = request.result.createObjectStore('files', { keyPath: ['sessionId', 'id'] }); store.createIndex('sessionId', 'sessionId') }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(new Error('附件存储不可用。'))
      request.onblocked = () => reject(new Error('附件存储被其他页面占用。'))
    })
  }
  async function transaction<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await open()
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('files', mode)
        const request = operation(tx.objectStore('files'))
        tx.oncomplete = () => resolve(request.result)
        tx.onerror = tx.onabort = () => reject(new Error('附件存储失败，请检查浏览器可用空间。'))
      })
    } finally { db.close() }
  }
  return {
    async put(file: StoredAttachment): Promise<void> { await transaction('readwrite', (store) => store.put(file)) },
    async get(sessionId: string, id: string): Promise<StoredAttachment> {
      const file = await transaction('readonly', (store) => store.get([sessionId, id])) as StoredAttachment | undefined
      if (!file) throw new Error('当前会话找不到此附件，请重新选择文件。')
      return file
    },
    async remove(sessionId: string, id: string): Promise<void> { await transaction('readwrite', (store) => store.delete([sessionId, id])) },
    async removeSession(sessionId: string): Promise<void> {
      const ids = await transaction('readonly', (store) => store.index('sessionId').getAllKeys(sessionId))
      if (!ids.length) return
      const db = await open()
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('files', 'readwrite')
          for (const id of ids) tx.objectStore('files').delete(id)
          tx.oncomplete = () => resolve()
          tx.onerror = tx.onabort = () => reject(new Error('无法清理会话附件。'))
        })
      } finally { db.close() }
    },
  }
}
export type AttachmentStore = ReturnType<typeof createAttachmentStore>
