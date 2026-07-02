// D-2 · 会话列表（SessionMeta）持久化 —— 独立于 HistoryDriver，专存会话列表（§1 DK1 / DK3 / §4 D-2）。
// ---------------------------------------------------------------------------
// 背景：DK1 持久化范围 = 会话列表（SessionMeta）+ 每会话 checkpoints；后者归 HistoryDriver，
//   前者归本文件。DK3 载体先浏览器 IndexedDB，接口不与 driver 耦合（此处不扩展 HistoryDriver，
//   独立一个 sessions 存储），桌面壳后续换 SQLite（块 Ta）时替换本实现即可。
//   存储设计：单个 object store `sessions`，**内联主键 keyPath `'id'`**（SessionMeta.id 唯一）。
//   · saveSessions：一个 readwrite 事务里先 clear() 再逐个 put —— 覆盖式落盘，保证盘上 = 传入列表
//     （删掉的会话不残留，改动的会话被覆盖）。
//   · loadSessions：getAll 返回全部 SessionMeta；无/出错 → []。
//   全过程 best-effort：环境无 indexedDB 或底层报错时**读退化为 []、写静默返回**，绝不抛
//   （对齐 indexedDbDriver 的降级契约）。不引任何未安装依赖 —— 纯原生 IndexedDB API
//   （jsdom 单测下由 fake-indexeddb 提供全局实现）。

import type { SessionMeta } from '../core.type'

const DEFAULT_DB_NAME = 'web-agent-sessions'
const STORE_NAME = 'sessions'

// 打开（必要时建库/建 store），失败/环境不支持则 reject —— 由各方法各自捕获降级。
function openDb(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined' || !indexedDB) {
      reject(new Error('IndexedDB unavailable'))
      return
    }
    const request = indexedDB.open(dbName, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('open failed'))
    request.onblocked = () => reject(new Error('open blocked'))
  })
}

// 简介：创建一个 IndexedDB 支撑的会话列表持久化器。
// 详情：dbName 可选（默认 'web-agent-sessions'）—— 供测试隔离或多实例并存。两个 async 方法：
//   saveSessions 覆盖式落盘（clear→put），loadSessions round-trip 取回全部。
export function createSessionsPersistence(dbName: string = DEFAULT_DB_NAME): {
  saveSessions(sessions: SessionMeta[]): Promise<void>
  loadSessions(): Promise<SessionMeta[]>
} {
  return {
    // 覆盖式落盘：一个 readwrite 事务里先 clear 再逐个 put，落盘结果与传入列表完全一致；出错静默返回。
    async saveSessions(sessions: SessionMeta[]): Promise<void> {
      let db: IDBDatabase
      try {
        db = await openDb(dbName)
      } catch {
        return
      }
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readwrite')
          const store = tx.objectStore(STORE_NAME)
          store.clear()
          for (const session of sessions) {
            store.put(session)
          }
          tx.oncomplete = () => resolve()
          tx.onerror = () => reject(tx.error)
          tx.onabort = () => reject(tx.error)
        })
      } catch {
        // best-effort：落盘失败不抛（对齐 indexedDbDriver 的降级语义）。
      } finally {
        db.close()
      }
    },

    // 取回全部会话（getAll）；空库/出错 → []。
    async loadSessions(): Promise<SessionMeta[]> {
      let db: IDBDatabase
      try {
        db = await openDb(dbName)
      } catch {
        return []
      }
      try {
        return await new Promise<SessionMeta[]>((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readonly')
          const req = tx.objectStore(STORE_NAME).getAll()
          req.onsuccess = () => resolve((req.result ?? []) as SessionMeta[])
          req.onerror = () => reject(req.error)
          tx.onerror = () => reject(tx.error)
        })
      } catch {
        return []
      } finally {
        db.close()
      }
    },
  }
}
