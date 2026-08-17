// 撤销 / 重做命令 —— 会话事务日志的用户入口。
// ---------------------------------------------------------------------------
// 两层粒度，都建立在同一串条目上：
//   · `undoTurn()` / `redoTurn()`：弹到轮标签变化为止 —— 用户按一次撤销退掉一整轮对话。
//     这是 UI 默认，因为一轮会产生十几条细粒度条目（追加用户消息、改 run 状态、回填工具结果…），
//     按条撤销对用户没有意义。
//   · `undoEntry()` / `redoEntry()`：弹一条 —— 开发者/可展开时间线用。
// 标签由 `writeSlot` 打（取 `RunState.turnId`），理由见 state/sessionSlotWrite.ts：
// `transaction()` 是同步的，而一轮是异步的，所以「一轮 = 一个事务」在机制上做不到。
//
// ## 运行中撤销 = 先停 run，再撤销
//
// 在飞的 run 会在 await 之后继续写这个 store，此刻撤销会让「已被回滚的世界」再被写入。
// 但本仓不需要 Rust 那样的 epoch（红线 6）就能挡住它，原因是：**`run` 本身是入账槽位**。
// 撤销一整轮会把「创建这个 run」那笔写入一起弹掉，于是 `runAtom.runId` 变了，而所有 await 后
// 的回写点都过 `isCurrentRun`（比对 runId）—— 迟到的写入自然被判为过期而丢弃。
// 也就是说保护机制早就在了，只是当时没意识到 undo 会把 runId 一起退回去。
//
// 所以这里不再拒绝，而是**替用户把 run 停掉再撤销**：他按撤销就是要那一轮消失，
// 让他先手动点停止只是多一步。停的时候传 `disposeUserContent: false` ——
// 释放是跨进程边界的不可逆动作，而状态马上要回滚，本来就没有东西真的变成不可达。
//
// ## 撤销有不可越过的地方
//
// 已经发生过的不可逆动作（用户显式停止 run 时真去删了 provider 侧的上传）会在账本上留下屏障，
// 越过它的撤销一律拒绝而不是「看起来成功了」。判据与理由见 state/undoBarrier.ts。

import type { History } from '@einfach/core'
import { activeSessionIdAtom } from '../../state/rootStore'
import { runAtom } from '../../state/sessionAtoms'
// 「在飞」的判定与 UI 可用态派生共用同一份状态集，避免按钮能点而命令拒绝。
import { IN_FLIGHT_RUN_STATUSES } from '../../state/sessionHistory'
import { undoBlockedByBarrier } from '../../state/undoBarrier'
import type { CoreInstance, SessionStore } from '../core/coreInstance'

/**
 * 停 run 的最小依赖面。收窄成一个函数而不是整个 runLifecycle：本命令唯一需要的就是
 * 「把在飞的 run 停掉，且不要释放用户内容」。
 */
export type StopRunForUndo = (options: { disposeUserContent: false }) => void

export type HistoryCommandRefusal =
  | 'no_session'
  | 'nothing_to_apply'
  | 'irreversible_barrier'

export interface HistoryCommandResult {
  ok: boolean
  /** 未生效时的原因，供 UI 说明「为什么按不动」。 */
  refusal?: HistoryCommandRefusal
  /** 本次实际弹/推了几条条目。 */
  entries: number
  /** 本次为了撤销而顺手把在飞的 run 停掉了（UI 可据此提示）。 */
  stoppedRun?: boolean
}

function refuse(refusal: HistoryCommandRefusal): HistoryCommandResult {
  return { ok: false, refusal, entries: 0 }
}

/**
 * 定位活动会话，并在 run 还在飞时先把它停掉。
 *
 * 停 run 不释放用户内容：状态马上要回滚，没有东西真的变成不可达（详见 state/undoBarrier.ts）。
 * 停完之后 run 状态已不在飞，撤销可以照常进行；而这一次停止本身产生的账目属于当前轮标签，
 * 会被同一次 `undoTurn` 一起弹掉。
 */
function prepareSession(
  core: CoreInstance,
  stopRun: StopRunForUndo,
): { session: SessionStore; stoppedRun: boolean } | HistoryCommandRefusal {
  const id = core.rootStore.getter(activeSessionIdAtom)
  if (!id) return 'no_session'
  const session = core.findSessionStore(id)
  if (!session) return 'no_session'
  const status = session.store.getter(runAtom)?.status
  if (status === undefined || !IN_FLIGHT_RUN_STATUSES.has(status)) {
    return { session, stoppedRun: false }
  }
  stopRun({ disposeUserContent: false })
  return { session, stoppedRun: true }
}

/** 游标前一条（undo 的下一个目标）的轮标签。 */
function labelBeforeCursor(history: History): string | undefined {
  const { entries, cursor } = history.getState()
  return cursor === 0 ? undefined : entries[cursor - 1]?.label
}

/** 游标处那一条（redo 的下一个目标）的轮标签。 */
function labelAtCursor(history: History): string | undefined {
  const { entries, cursor } = history.getState()
  return cursor >= entries.length ? undefined : entries[cursor]?.label
}

/**
 * 反复调 step，直到下一个目标的标签与首条不同。
 *
 * 无标签的条目（尚无 run 时产生，如输入框草稿）只弹一条：它们不属于任何一轮，
 * 成组回滚会把不相关的编辑一起吃掉。
 */
function applyWhileSameLabel(
  history: History,
  peek: (history: History) => string | undefined,
  step: () => boolean,
): HistoryCommandResult {
  const label = peek(history)
  if (!step()) return refuse('nothing_to_apply')
  let entries = 1
  if (label === undefined) return { ok: true, entries }
  while (peek(history) === label) {
    if (!step()) break
    entries += 1
  }
  return { ok: true, entries }
}

/** Builds undo/redo commands bound to one runtime core. */
export function createHistoryCommands(core: CoreInstance, stopRun: StopRunForUndo) {
  function run(
    peek: (history: History) => string | undefined,
    pick: (history: History) => () => boolean,
    grouped: boolean,
    direction: 'undo' | 'redo',
  ): HistoryCommandResult {
    const prepared = prepareSession(core, stopRun)
    if (typeof prepared === 'string') return refuse(prepared)
    const { session, stoppedRun } = prepared
    // 屏障只挡撤销：重做是往新的方向走，不会越过它。
    if (direction === 'undo' && undoBlockedByBarrier(session.store, session.history)) {
      return { ...refuse('irreversible_barrier'), ...(stoppedRun ? { stoppedRun } : {}) }
    }
    const step = pick(session.history)
    const outcome = grouped
      ? applyWhileSameLabel(session.history, peek, step)
      : (step() ? { ok: true, entries: 1 } : refuse('nothing_to_apply'))
    return { ...outcome, ...(stoppedRun ? { stoppedRun } : {}) }
  }

  return {
    /** 撤销一整轮（弹到轮标签变化为止）。UI 默认粒度。 */
    undoTurn: (): HistoryCommandResult =>
      run(labelBeforeCursor, (history) => () => history.undo(), true, 'undo'),
    /** 重做一整轮。 */
    redoTurn: (): HistoryCommandResult =>
      run(labelAtCursor, (history) => () => history.redo(), true, 'redo'),
    /** 撤销一条条目。开发者粒度，UI 暂未暴露。 */
    undoEntry: (): HistoryCommandResult =>
      run(labelBeforeCursor, (history) => () => history.undo(), false, 'undo'),
    /** 重做一条条目。 */
    redoEntry: (): HistoryCommandResult =>
      run(labelAtCursor, (history) => () => history.redo(), false, 'redo'),
  }
}
