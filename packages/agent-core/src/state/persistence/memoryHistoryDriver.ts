// P8 · 内存 HistoryDriver 实现（占位）—— 纯内存 Map，不落盘。
// ---------------------------------------------------------------------------
// 背景：C1 本轮只定 driver 抽象 + 内存实现；真实 SQLite（tauri-plugin-sql）留后续。
//   这里用 Map<sessionId, Checkpoint[]> 承载「按会话分区、按 turnIndex 递增的一串快照」，
//   把 HistoryDriver 的五个 async 方法各自落到 Map 上。**不引 tauri/sql/idb 任何依赖**。
//   方法虽是同步操作，仍返回 Promise —— 与接口的异步契约一致（未来换 SQL 实现不改签名，R4）。

import type { Checkpoint, CheckpointMeta } from '../checkpoint.type'
import type { HistoryDriver } from './historyDriver'

// 简介：创建一个纯内存的 HistoryDriver（进程内、不持久化）。
// 详情：内部维护 bySession —— 每个会话一串按追加顺序排列的 Checkpoint；实例之间互相隔离
//   （每次 create 新建独立 Map），便于测试。列表返回去 items 的轻量 CheckpointMeta。
export function createMemoryHistoryDriver(): HistoryDriver {
  const bySession = new Map<string, Checkpoint[]>()

  return {
    // 列某会话所有轮的轻量元信息（去 items）；无该会话则 []。
    async listCheckpoints(sessionId: string): Promise<CheckpointMeta[]> {
      const list = bySession.get(sessionId) ?? []
      return list.map(({ turnIndex, label, createdAt }) => ({ turnIndex, label, createdAt }))
    },

    // 取某会话中 turnIndex 匹配的完整快照（含 items）；不存在/越界返回 undefined。
    async loadCheckpoint(sessionId: string, turnIndex: number): Promise<Checkpoint | undefined> {
      const list = bySession.get(sessionId)
      return list?.find((cp) => cp.turnIndex === turnIndex)
    },

    // 追加一个 checkpoint 到该会话历史尾部（会话不存在则新建列表）。
    async saveCheckpoint(sessionId: string, checkpoint: Checkpoint): Promise<void> {
      const list = bySession.get(sessionId)
      if (list) {
        list.push(checkpoint)
      } else {
        bySession.set(sessionId, [checkpoint])
      }
    },

    // 只保留该会话中 turnIndex <= 给定值的 checkpoint（删除之后的，截断式回退，C2）。
    async truncateAfter(sessionId: string, turnIndex: number): Promise<void> {
      const list = bySession.get(sessionId)
      if (!list) return
      bySession.set(
        sessionId,
        list.filter((cp) => cp.turnIndex <= turnIndex),
      )
    },

    // 清空某会话的全部历史。
    async deleteSession(sessionId: string): Promise<void> {
      bySession.delete(sessionId)
    },
  }
}
