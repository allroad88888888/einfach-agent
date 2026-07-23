// 会话内的共享单例 atom key —— 值随 store 隔离，绝不做 Record<sessionId> 分桶。
// ---------------------------------------------------------------------------
// einfach 机制备忘（C3）：`atom` 只是「key」，值真正存在「store」里；同一个 atom key
// 在不同 store 里持有的是彼此独立的值。所以「每会话一个 store」时，会话内状态只需在此
// 定义「一次」共享 key —— 每个 session store 各自持有自己那份 items/run/checkpoints，
// 天然隔离，无需也禁止把它们做成 `Record<sessionId, _>` 分桶。

import { atom } from '@einfach/core'
import type { ConversationItem, RunState } from './core.type'
import type { Checkpoint } from './checkpoint.type'
import type { PlanSnapshot } from '../planning/types'

// 简介：当前会话的对话历史。
// 详情：值随 store 隔离——每个 session store 里是各自独立的 ConversationItem[]，非分桶。
export const itemsAtom = atom<ConversationItem[]>([])

// 简介：当前会话的 run 状态（无 run 时 undefined）。
// 详情：值随 store 隔离——每个 session store 各持一份 RunState，非分桶。
export const runAtom = atom<RunState | undefined>(undefined)

// 简介：当前会话的 checkpoint 列表（回退用的快照序列）。
// 详情：值随 store 隔离——每个 session store 各持一份 Checkpoint[]，非分桶。
export const checkpointsAtom = atom<Checkpoint[]>([])

// 简介：当前会话「停在第几轮」的游标（-1 表示尚无 checkpoint）。
// 详情：值随 store 隔离——每个 session store 各持一份 number，非分桶。
export const currentTurnIndexAtom = atom<number>(-1)

// 当前会话的结构化执行计划。它是运行时与 UI 的唯一内存状态源；SessionMeta.plan 仅是持久化副本。
export const planAtom = atom<PlanSnapshot | undefined>(undefined)
