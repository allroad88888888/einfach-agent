// 单 object-store IndexedDB transaction 的完成、失败与主动中止协议。

export interface IndexedDbTransactionErrors {
  failed: string
  aborted: string
}

export type IndexedDbTransactionOperation<T> = (
  store: IDBObjectStore,
  setResult: (result: T) => void,
  fail: (error: unknown) => void,
) => void

/** 只在 transaction complete 后 resolve；同步或请求错误会中止并保留原始错误。 */
export function runIndexedDbTransaction<T>(
  db: IDBDatabase,
  storeName: string,
  mode: IDBTransactionMode,
  errors: IndexedDbTransactionErrors,
  operation: IndexedDbTransactionOperation<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode)
    let result: T | undefined
    let failure: unknown
    const fail = (error: unknown) => {
      failure = error
      try {
        transaction.abort()
      } catch {
        // 已完成或已中止时仍由 transaction 事件统一结算。
      }
    }
    transaction.oncomplete = () => resolve(result as T)
    transaction.onerror = () => reject(failure ?? transaction.error ?? new Error(errors.failed))
    transaction.onabort = () => reject(failure ?? transaction.error ?? new Error(errors.aborted))
    try {
      operation(transaction.objectStore(storeName), (value) => { result = value }, fail)
    } catch (error) {
      fail(error)
    }
  })
}
