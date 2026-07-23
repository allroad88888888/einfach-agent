// 持久化 driver 抽象（只接口，不含实现）—— 把「会话历史 checkpoint 的读写」与具体存储解耦。
// ---------------------------------------------------------------------------
// 背景：桌面壳 = Tauri，持久化目标 = SQLite（tauri-plugin-sql，见 §1 C1）。本轮**只定 driver 抽象**，
//   内存实现（createMemoryHistoryDriver）留到 P8、真实 SQLite 实现留到后续。
//   全部方法 async —— 未来底层是异步 IO（SQL / IndexedDB），接口先按异步定，避免后续破坏性改签名（R4）。
//   回退语义为「截断式」（跳回第 N 轮 = 丢弃 N 之后，git reset --hard 语义，见 §1 C2），对应 truncateAfter。

import type { Checkpoint, CheckpointMeta } from '../checkpoint.type'

// 简介：会话历史（checkpoint）的持久化 driver 抽象，所有方法均为异步。
// 详情：内容按 sessionId 分区；每个会话是一串按 turnIndex 递增的 Checkpoint。
//   列表用轻量 CheckpointMeta（不含 items），取整段快照才用 loadCheckpoint。
export interface HistoryDriver {
  // 列某会话所有轮的轻量元信息（不含 items），供列表 UI 懒加载渲染。
  listCheckpoints(sessionId: string): Promise<CheckpointMeta[]>

  // 取某会话某一轮的完整快照（含 items）；turnIndex 越界时返回 undefined。
  loadCheckpoint(sessionId: string, turnIndex: number): Promise<Checkpoint | undefined>

  // 追加一个 checkpoint 到某会话历史尾部（一轮对话结束时的整段快照）。
  saveCheckpoint(sessionId: string, checkpoint: Checkpoint): Promise<void>

  // 删除某会话中 turnIndex **之后**的所有 checkpoint（截断式回退，保留到 turnIndex，见 C2）。
  truncateAfter(sessionId: string, turnIndex: number): Promise<void>

  // 清空某会话的全部历史（删除该会话所有 checkpoint）。
  deleteSession(sessionId: string): Promise<void>
}
