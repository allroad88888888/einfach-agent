// 一个会话的事务日志怎么建 —— 建日志与登记 applier 是同一件事，不许分开做。
// ---------------------------------------------------------------------------
// 为什么单独一个工厂：`createHistory(store)` 建出来的日志是空的，`record()` 碰到未登记的 key
// 会抛错。于是「建日志」和「按 SESSION_SLOTS 登记 applier」必须成对发生，而这个循环一旦被
// 复制到第二个地方（运行时装配一份、测试夹具一份），就会出现「有账本但记不进去」的日志。
// 实测过这个失败模式：插件测试的假 ctx 拿了裸 createHistory，7 条用例在第一次写入时全红。
// 收成一个工厂之后，拿到 History 就必然是登记好的。
//
// 这里还挂一个派生 atom `undoAvailabilityAtom`，供 UI 绑按钮的可用态。放在这里而不是让 UI 自己
// 拼，是因为「什么情况下不能撤销」是一条**策略**：UI 若自己判 run 状态，那份状态列表就有了第二份
// 副本，两边一漂移，按钮显示可点而命令实际拒绝。派生自同一份真相，UI 就只是显示。

import { atom, createHistory, type Atom, type History, type Store } from '@einfach/core'
import { runAtom } from './sessionAtoms'
import { SESSION_SLOTS, SESSION_SLOT_KEYS } from './sessionSlots'

/**
 * run 正在推进、随时会在 await 之后回写状态的状态集。
 *
 * 真相收在这里，`runtime/commands/historyCommands.ts` 的拒绝判定与本文件的可用态派生共用它 ——
 * 两处各写一份是「按钮能点但命令拒绝」的现成来源。
 */
export const IN_FLIGHT_RUN_STATUSES: ReadonlySet<string> = new Set(['running', 'awaiting_tool'])

/** 撤销/重做在此刻是否可用，以及不可用的原因（供 UI 说明「为什么按不动」）。 */
export interface UndoAvailability {
  canUndo: boolean
  canRedo: boolean
  /** 有账可退但当下不许退时给出原因；纯粹「没有账可退」不算原因。 */
  blocked?: 'run_in_flight'
}

/** 一本会话日志，外加 UI 绑定用的可用态。 */
export interface SessionHistory extends History {
  readonly undoAvailabilityAtom: Atom<UndoAvailability>
}

/**
 * 为一个会话 store 建一本登记完备的事务日志。
 *
 * 穷举登记而不是按需登记：漏一个槽位不会静默失效，而是在第一次写它时当场抛，
 * 这正是想要的方向 —— 记一笔无法回放的账比抛错糟得多。
 */
export function createSessionHistory(store: Store): SessionHistory {
  const history = createHistory(store)
  for (const key of SESSION_SLOT_KEYS) SESSION_SLOTS[key].registerApplier(history)

  // 纯派生：只从 get 取值，不读时钟/随机数（CLAUDE.md 规则 1 —— 否则重放算不出同样结果）。
  const undoAvailabilityAtom = atom<UndoAvailability>((get) => {
    const stack = get(history.stackAtom)
    const status = get(runAtom)?.status
    const inFlight = status !== undefined && IN_FLIGHT_RUN_STATUSES.has(status)
    const hasUndo = stack.cursor > 0
    const hasRedo = stack.cursor < stack.entries.length
    return {
      canUndo: hasUndo && !inFlight,
      canRedo: hasRedo && !inFlight,
      ...(inFlight && (hasUndo || hasRedo) ? { blocked: 'run_in_flight' as const } : {}),
    }
  })
  undoAvailabilityAtom.debugLabel = 'session.undoAvailability'

  return { ...history, undoAvailabilityAtom }
}
