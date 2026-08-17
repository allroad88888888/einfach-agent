// 带记账的槽位写入 —— 会话状态写入事务日志的唯一入口。
// ---------------------------------------------------------------------------
// einfach 的 `createHistory` **不订阅任何 atom、也不自动推断改了什么**，变更必须在
// `transaction()` 内用 `record()` 显式声明。理由与 Rust 侧红线 2 相同：自动捕获要给每个被追踪
// atom 常驻订阅和基线值，成本 O(被追踪 atom 数)，会话/子 Agent 一多就不成立。
//
// 于是问题变成「谁来 record」。答案不是「每个改状态的地方各写一笔」——几十处调用点，忘一处就漏账，
// 而漏账不报错。答案是让写入只能从 `state/` 的写入器走，**record 由写入器内部带**：每个写入器
// 自己知道它写哪个槽位，所以声明仍然是显式的，只是每个槽位声明一次、而不是每个调用点声明一次。
//
// `transaction()` 可嵌套（内层只累积、最外层提交），所以：
//   · 单独调一个写入器 = 一步 undo；
//   · 命令层用一个 `transaction(label, ...)` 包住若干写入器 = 合并成一步 undo。
// 写入器因此不必知道自己是否处在更大的事务里。
//
// 值没真变的写入整体短路：不开事务、不写 store、不记账（`commit()` 本来也会过滤掉这种 op）。
//
// ## 条目为什么按「轮」打标签
//
// `transaction()` 是**同步**的：`fn()` 一返回就提交。而一轮对话是异步的（模型请求、工具执行都在
// await 之后），所以「一整轮 = 一个 transaction」在机制上做不到 —— 后续写入会落在提交之后。
// 可行的是让同一轮产生的条目带**同一个标签**，撤销时连续弹到标签变化为止。
// 标签取 `RunState.turnId`：它已经是本轮的锚点、已经在恢复快照里，不必另造一套编号。
// 于是粒度是两层且都白拿：弹到标签变化 = 退一整轮（UI 默认），弹一条 = 开发者级。

import type { AtomEntity, History, Store } from '@einfach/core'
import { runAtom } from './sessionAtoms'

/**
 * 一次带记账的槽位写入所需的最小上下文：状态放哪、账记哪本。
 *
 * 刻意用结构类型而不是具体类型：`SessionStore`（`{ id, store, history }`）与插件拿到的
 * `CoreCtx` 都天然满足它，写入器因此不必为两种调用方各开一个重载。
 */
export interface SlotWriteTarget {
  readonly store: Store
  readonly history: History
}

/**
 * 写一个会话槽位并记一笔账。
 *
 * `key` 取自 `SESSION_SLOTS[...].key`（落盘逻辑名），不要现写字面量 —— 它是事务日志里
 * `op.key` 的取值，与 applier 的注册名必须逐字一致，否则 undo 会因为找不到 applier 而整条失败。
 *
 * 写入统一包一层 thunk：`atom(initialValue)` 合成的 write 会把函数参数当 updater 执行，
 * 不包的话「值本身是函数」和「更新函数」就分不开。einfach 自己的 applier 也是这么做的。
 */
export function writeSlot<State>(
  target: SlotWriteTarget,
  key: string,
  atom: AtomEntity<State>,
  next: State | ((previous: State) => State),
  /**
   * 覆盖本次写入的轮标签。默认读写入**之前**的 `runAtom.turnId`，这对绝大多数写入都对；
   * 唯独「创建/切换 run」那一次要显式传即将写入的 turnId，否则它会被归到上一轮去。
   */
  turnLabel?: string,
): void {
  // 值没真变就整体短路：不开事务、不写 store、不记账。
  // einfach 的 commit() 本来也会把 Object.is(before, after) 的 op 过滤掉，所以行为一致；
  // 差别在于这里连 transaction + publish 都省了 —— 主循环里「把状态设成它已经是的值」很常见
  // （patchRun 的状态转移尤其如此），每次都走一遍提交会把日志开销放大到无谓的地步。
  // getter 为 promise atom 返回条件类型；槽位 atom 一律是 JSON 安全值、绝不持 promise
  // （恢复 codec 就按这条校验），故这里收窄成 State。
  const current = target.store.getter(atom) as State
  const resolved = typeof next === 'function'
    ? (next as (previous: State) => State)(current)
    : next
  if (Object.is(current, resolved)) return

  inTurnTransaction(target, () => {
    target.store.setter(atom, () => resolved)
    target.history.record({ key, before: current, after: resolved })
  }, turnLabel)
}

/**
 * 把一次写入 + 记账包进带轮标签的事务。
 *
 * 单独抽出来是因为「记什么」有多种形状：整值槽位记 `(before, after)` 两份完整值，而
 * 增量记账（见 sessionItemsLog.ts）只记被动的那一条。两者共享的恰恰只有这里的标签取值
 * 与事务边界，抄第二遍就会漂移。
 */
export function inTurnTransaction(
  target: SlotWriteTarget,
  write: () => void,
  turnLabel?: string,
): void {
  const label = turnLabel ?? currentTurnLabel(target.store)
  // 不能写成 transaction(label ?? '')：einfach 会把空串当成一个真标签存下来，而
  // 「没有标签」与「标签是空串」在「弹到标签变化为止」的判定里是两回事。
  if (label === undefined) target.history.transaction(write)
  else target.history.transaction(label, write)
}

/** 本会话当前所处的轮标签；尚无 run 时返回 undefined（此类写入各自成一条）。 */
export function currentTurnLabel(store: Store): string | undefined {
  return store.getter(runAtom)?.turnId
}
