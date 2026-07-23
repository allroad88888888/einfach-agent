// 「回退到某次对话」的 checkpoint 数据模型（类型）—— 必须可 JSON 序列化（C5）。配套 atom 在 checkpoint.ts。
// ---------------------------------------------------------------------------
// 思路：借鉴 createUndoRedo 的「快照→恢复」，但弃其 WeakMap[] 存储（不可序列化，与持久化冲突）。
//   · 一轮对话结束 → 把当时的 items 整体快照下来（Checkpoint），供之后截断式回退（git reset --hard 语义）。
//   · 列表 UI 只需轻量元信息，不必加载整段 items → CheckpointMeta。
// 这里只定「形状」；写入/回退 helper 在 checkpointWriters.ts，持久化 driver 在 persistence/*。

import type { ConversationItem } from './core.type'

// ===========================================================================
// 一、一轮对话的快照
// ===========================================================================

// 简介：一轮对话结束时的完整快照（可 JSON 序列化）。
// 详情：turnIndex 是这次快照对应的对话轮序号（回退目标）；label 供列表展示；createdAt 排序；
// items 是当时 itemsBySession 的整段拷贝，jumpTo 时原样恢复。全部字段均为原始可序列化数据（C5）。
export interface Checkpoint {
  turnIndex: number
  label: string
  createdAt: number
  items: ConversationItem[]
}

// ===========================================================================
// 二、列表用的轻量元信息
// ===========================================================================

// 简介：Checkpoint 去掉 items 的轻量版（供列表 UI）。
// 详情：不含 items，供列表懒加载 —— 列表只渲染 turnIndex / label / createdAt，点进某轮再按需取整段 items。
export type CheckpointMeta = Omit<Checkpoint, 'items'>
