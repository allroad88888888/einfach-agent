// 「回退到某次对话」的 checkpoint 数据模型（类型）—— 必须可 JSON 序列化（C5）。配套 atom 在 checkpoint.ts。
// ---------------------------------------------------------------------------
// 思路：借鉴 createUndoRedo 的「快照→恢复」，但弃其 WeakMap[] 存储（不可序列化，与持久化冲突）。
//   · 一轮对话结束 → 把当时的 items 整体快照下来（Checkpoint），供之后截断式回退（git reset --hard 语义）。
//   · 列表 UI 只需轻量元信息，不必加载整段 items → CheckpointMeta。
// 这里只定「形状」；写入/回退 helper 在 checkpointWriters.ts，持久化 driver 在 persistence/*。

import type { ConversationItem, RunState } from './core.type'
import type { QueuedUserMessage } from './transientAtoms'
import type { PlanSnapshot } from '../planning/types'

// ===========================================================================
// 一、一轮对话的快照
// ===========================================================================

// 简介：一轮对话结束时的完整快照（可 JSON 序列化）。
// 详情：turnIndex 是这次快照对应的对话轮序号（回退目标）；label 供列表展示；createdAt 排序；
// items 是当时 itemsBySession 的整段拷贝，plan 是同一时刻的结构化计划；jumpTo 时两者原样恢复。
// plan 可选以兼容尚未保存计划快照的旧 checkpoint。全部字段均为原始可序列化数据（C5）。
export interface Checkpoint {
  turnIndex: number
  label: string
  createdAt: number
  items: ConversationItem[]
  // 新 checkpoint 用结构化状态表示运行结果；可选以兼容尚未迁移的旧 label 前缀数据。
  kind?: CheckpointKind
  finishReason?: CheckpointFinishReason
  plan?: PlanSnapshot
  recovery?: RunRecoverySnapshot
  planStageCheckpoints?: PlanStageCheckpoint[]
}

export type CheckpointKind = 'working' | 'completed' | 'stopped' | 'abnormal'

export type CheckpointFinishReason = string

export interface CheckpointState {
  kind: CheckpointKind
  finishReason?: CheckpointFinishReason
}

// 简介：一个计划阶段「开始之前」的回退点。
// 详情：checkpoint 的粒度是「用户消息轮」，而一个计划的几十次阶段推进通常全部发生在同一轮内，
// 轮级回退因此够不着计划内部（回退整轮 = 计划整个消失，回退别的轮 = 计划纹丝不动）。
// 阶段回退点补上这一层：某阶段首次进入 in_progress 时记一笔「变更前的计划快照 + 当时的 items 长度」，
// 回退该阶段 = 恢复这份计划快照 + 把对话截断回 itemCount，让模型从干净状态重跑该阶段。
// plan 是阶段开始前的快照（该阶段在其中仍是 pending），itemCount 是打点时 itemsAtom 的长度。
// 与 Checkpoint 一样必须可 JSON 序列化（C5）。
export interface PlanStageCheckpoint {
  stageId: string
  plan: PlanSnapshot
  itemCount: number
  createdAt: number
}

// ===========================================================================
// 二、列表用的轻量元信息
// ===========================================================================

// 简介：Checkpoint 去掉完整会话状态的轻量版（供列表 UI）。
// 详情：不含 items / plan / recovery / planStageCheckpoints，供列表懒加载 ——
// 列表只渲染 turnIndex / label / createdAt。
export type CheckpointMeta = Omit<
  Checkpoint,
  'items' | 'plan' | 'recovery' | 'planStageCheckpoints'
>
// 活动轮的恢复信息直接跟随工作 checkpoint 落盘。它不是第二套状态源：
// checkpoint 仍是历史和恢复的唯一持久化单元，runAtom/队列只在 hydrate 时由最新 checkpoint 回填。
export interface RunRecoverySnapshot {
  run: RunState
  queuedUserMessages?: QueuedUserMessage[]
}
