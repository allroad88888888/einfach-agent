// D-1 · IndexedDB HistoryDriver 实现 —— 浏览器载体（对齐内存版语义，见 §1 DK3 / D-1）。
// ---------------------------------------------------------------------------
// 背景：DK3 载体先浏览器 IndexedDB，`HistoryDriver` 接口不变；桌面壳后续换 SQLite（块 Ta）。
//   存储设计：单个 object store `checkpoints`，**复合主键 keyPath `[sessionId, turnIndex]`**（内联键），
//   记录形状 = { sessionId, turnIndex, checkpoint }（turnIndex 冗余到顶层供复合键提取）。
//   · 按 sessionId 查询/删除：用「复合键前缀区间」IDBKeyRange.bound([sid], [sid, []])——
//     数组键排序里 [sid]（长度 1）< [sid, 任意 number]，而空数组 [] 比任何 number 大，
//     故该区间正好覆盖某会话的全部 [sid, number] 键（listCheckpoints / deleteSession）。
//   · loadCheckpoint：主键 get([sid, turnIndex])。
//   · truncateAfter(N)：删「> N」的键 = 下界开区间 bound([sid, N], [sid, []], true, false)。
//   打开/事务用法参考旧 src/agent/state/persistence.ts 的 IndexedDbDriver（每次操作 open→用→close）。
//   全过程 best-effort：环境无 indexedDB 或底层报错时**读退化为空、写静默返回**，绝不抛（对齐旧 driver 的降级契约）。
//   不引任何未安装依赖 —— 纯原生 IndexedDB API（jsdom 单测下由 fake-indexeddb 提供全局实现）。

import type { Checkpoint, CheckpointMeta } from '../checkpoint.type'
import type { HistoryDriver } from './historyDriver'

const DEFAULT_DB_NAME = 'web-agent-history'
const STORE_NAME = 'checkpoints'

// 落盘记录：checkpoint 原样存于 checkpoint 字段；sessionId / turnIndex 提到顶层供复合主键提取。
interface StoredRecord {
  sessionId: string
  turnIndex: number
  checkpoint: Checkpoint
}

// 某会话全部 checkpoint 的复合键前缀区间：[sid] .. [sid, []]（含端点）。
function sessionRange(sessionId: string): IDBKeyRange {
  return IDBKeyRange.bound([sessionId], [sessionId, []])
}

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
        db.createObjectStore(STORE_NAME, { keyPath: ['sessionId', 'turnIndex'] })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('open failed'))
    request.onblocked = () => reject(new Error('open blocked'))
  })
}

// 简介：创建一个 IndexedDB 支撑的 HistoryDriver。
// 详情：dbName 可选（默认 'web-agent-history'）—— 供测试隔离或多实例并存。五个 async 方法
//   语义与 createMemoryHistoryDriver 完全对齐（list 去 items、load 越界 undefined、
//   truncateAfter 保留 <= N、deleteSession 清空、会话互相隔离）。
export function createIndexedDbHistoryDriver(dbName: string = DEFAULT_DB_NAME): HistoryDriver {
  return {
    // 列某会话所有轮的轻量元信息（去 items），按主键升序（即 turnIndex 升序）；无该会话/出错 → []。
    async listCheckpoints(sessionId: string): Promise<CheckpointMeta[]> {
      let db: IDBDatabase
      try {
        db = await openDb(dbName)
      } catch {
        return []
      }
      try {
        const records = await new Promise<StoredRecord[]>((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readonly')
          const req = tx.objectStore(STORE_NAME).getAll(sessionRange(sessionId))
          req.onsuccess = () => resolve((req.result ?? []) as StoredRecord[])
          req.onerror = () => reject(req.error)
          tx.onerror = () => reject(tx.error)
        })
        return records.map(({ checkpoint: { turnIndex, label, createdAt } }) => ({
          turnIndex,
          label,
          createdAt,
        }))
      } catch {
        return []
      } finally {
        db.close()
      }
    },

    // 取某会话某一轮的完整快照（含 items）；不存在/越界/出错 → undefined。
    async loadCheckpoint(sessionId: string, turnIndex: number): Promise<Checkpoint | undefined> {
      let db: IDBDatabase
      try {
        db = await openDb(dbName)
      } catch {
        return undefined
      }
      try {
        const record = await new Promise<StoredRecord | undefined>((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readonly')
          const req = tx.objectStore(STORE_NAME).get([sessionId, turnIndex])
          req.onsuccess = () => resolve(req.result as StoredRecord | undefined)
          req.onerror = () => reject(req.error)
          tx.onerror = () => reject(tx.error)
        })
        return record?.checkpoint
      } catch {
        return undefined
      } finally {
        db.close()
      }
    },

    // 追加/覆盖某会话某一轮的 checkpoint（复合主键，同 turnIndex 幂等覆盖）；出错静默返回（best-effort）。
    async saveCheckpoint(sessionId: string, checkpoint: Checkpoint): Promise<void> {
      let db: IDBDatabase
      try {
        db = await openDb(dbName)
      } catch {
        return
      }
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readwrite')
          const record: StoredRecord = { sessionId, turnIndex: checkpoint.turnIndex, checkpoint }
          tx.objectStore(STORE_NAME).put(record)
          tx.oncomplete = () => resolve()
          tx.onerror = () => reject(tx.error)
          tx.onabort = () => reject(tx.error)
        })
      } catch {
        // best-effort：落盘失败不抛（对齐旧 IndexedDbDriver.save 的降级语义）。
      } finally {
        db.close()
      }
    },

    // 删某会话中 turnIndex **> N** 的所有 checkpoint（保留 <= N，截断式回退，C2）；出错静默返回。
    async truncateAfter(sessionId: string, turnIndex: number): Promise<void> {
      let db: IDBDatabase
      try {
        db = await openDb(dbName)
      } catch {
        return
      }
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readwrite')
          // 下界开区间：排除 [sid, N] 本身，删掉其后到 [sid, []] 的全部（即所有 turnIndex' > N）。
          const range = IDBKeyRange.bound([sessionId, turnIndex], [sessionId, []], true, false)
          tx.objectStore(STORE_NAME).delete(range)
          tx.oncomplete = () => resolve()
          tx.onerror = () => reject(tx.error)
          tx.onabort = () => reject(tx.error)
        })
      } catch {
        // best-effort
      } finally {
        db.close()
      }
    },

    // 清空某会话的全部历史（删除该会话所有 checkpoint）；出错静默返回。
    async deleteSession(sessionId: string): Promise<void> {
      let db: IDBDatabase
      try {
        db = await openDb(dbName)
      } catch {
        return
      }
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readwrite')
          tx.objectStore(STORE_NAME).delete(sessionRange(sessionId))
          tx.oncomplete = () => resolve()
          tx.onerror = () => reject(tx.error)
          tx.onabort = () => reject(tx.error)
        })
      } catch {
        // best-effort
      } finally {
        db.close()
      }
    },
  }
}
