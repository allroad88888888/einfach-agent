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
// ## 运行中不许撤销
//
// 在飞的 run 会在 await 之后继续写这个 store。此刻撤销会让「已被回滚的世界」再被写入 ——
// Rust 侧靠 epoch 解决（红线 6：effect 带 epoch、回写前比对、undo 时 bump）。本仓的
// runId stale guard 与 AbortSignal 覆盖的是「run 被换掉」，不覆盖「状态被回滚而 run 还在」，
// 所以这里 fail-closed：run 处于 running / awaiting_tool 时拒绝，由调用方先 stopRun。
// 要放开成「撤销时自动停 run」需要先补 epoch，那是独立一步，不在本命令里偷偷做。

import type { History } from '@einfach/core'
import { activeSessionIdAtom } from '../../state/rootStore'
import { runAtom } from '../../state/sessionAtoms'
import type { CoreInstance } from '../core/coreInstance'

/** run 正在推进、随时会在 await 之后回写的状态。 */
const IN_FLIGHT_RUN_STATUSES = new Set(['running', 'awaiting_tool'])

export type HistoryCommandRefusal = 'no_session' | 'run_in_flight' | 'nothing_to_apply'

export interface HistoryCommandResult {
  ok: boolean
  /** 未生效时的原因，供 UI 说明「为什么按不动」。 */
  refusal?: HistoryCommandRefusal
  /** 本次实际弹/推了几条条目。 */
  entries: number
}

function refuse(refusal: HistoryCommandRefusal): HistoryCommandResult {
  return { ok: false, refusal, entries: 0 }
}

/** 定位活动会话的日志，并挡住运行中的撤销。 */
function activeHistory(core: CoreInstance): History | HistoryCommandRefusal {
  const id = core.rootStore.getter(activeSessionIdAtom)
  if (!id) return 'no_session'
  const session = core.findSessionStore(id)
  if (!session) return 'no_session'
  const status = session.store.getter(runAtom)?.status
  if (status !== undefined && IN_FLIGHT_RUN_STATUSES.has(status)) return 'run_in_flight'
  return session.history
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
export function createHistoryCommands(core: CoreInstance) {
  function run(
    peek: (history: History) => string | undefined,
    pick: (history: History) => () => boolean,
    grouped: boolean,
  ): HistoryCommandResult {
    const history = activeHistory(core)
    if (typeof history === 'string') return refuse(history)
    const step = pick(history)
    if (!grouped) return step() ? { ok: true, entries: 1 } : refuse('nothing_to_apply')
    return applyWhileSameLabel(history, peek, step)
  }

  return {
    /** 撤销一整轮（弹到轮标签变化为止）。UI 默认粒度。 */
    undoTurn: (): HistoryCommandResult =>
      run(labelBeforeCursor, (history) => () => history.undo(), true),
    /** 重做一整轮。 */
    redoTurn: (): HistoryCommandResult =>
      run(labelAtCursor, (history) => () => history.redo(), true),
    /** 撤销一条条目。开发者粒度，UI 暂未暴露。 */
    undoEntry: (): HistoryCommandResult =>
      run(labelBeforeCursor, (history) => () => history.undo(), false),
    /** 重做一条条目。 */
    redoEntry: (): HistoryCommandResult =>
      run(labelAtCursor, (history) => () => history.redo(), false),
  }
}
