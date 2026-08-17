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
// 值没真变的写入不会占一步 undo：`commit()` 会把 `Object.is(before, after)` 的 op 过滤掉。

import type { AtomEntity, History, Store } from '@einfach/core'

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
): void {
  target.history.transaction(() => {
    // getter 为 promise atom 返回条件类型；槽位 atom 一律是 JSON 安全值、绝不持 promise
    // （恢复 codec 就按这条校验），故这里收窄成 State。
    const before = target.store.getter(atom) as State
    const after = typeof next === 'function'
      ? (next as (previous: State) => State)(before)
      : next
    target.store.setter(atom, () => after)
    target.history.record({ key, before, after })
  })
}
