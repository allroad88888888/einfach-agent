// 计划阶段回退点的数据模型（类型）—— 必须可 JSON 序列化（C5）。
// ---------------------------------------------------------------------------
// 本文件从原 checkpoint.type.ts 拆出：那里曾同时装着「用户 undo 的轮级快照」与本类型，
// 而两者的存亡不同 —— 轮级 checkpoint 已随 undo 迁移到 einfach 的事务日志（createHistory）
// 整体删除，阶段回退点则留下，因为它在 RecoverySnapshotV1 的 plan.stageCheckpoints 里。

import type { PlanSnapshot } from '../planning/types'

// 简介：一个计划阶段「开始之前」的回退点。
// 详情：计划的几十次阶段推进通常全部发生在同一轮对话内，轮级回退因此够不着计划内部
// （回退整轮 = 计划整个消失，回退别的轮 = 计划纹丝不动）。阶段回退点补上这一层：
// 某阶段首次进入 in_progress 时记一笔「变更前的计划快照 + 当时的 items 长度」，
// 回退该阶段 = 恢复这份计划快照 + 把对话截断回 itemCount，让模型从干净状态重跑该阶段。
// plan 是阶段开始前的快照（该阶段在其中仍是 pending），itemCount 是打点时 itemsAtom 的长度。
export interface PlanStageCheckpoint {
  stageId: string
  plan: PlanSnapshot
  itemCount: number
  createdAt: number
}
