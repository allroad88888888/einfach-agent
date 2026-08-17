// 一个会话的事务日志怎么建 —— 建日志与登记 applier 是同一件事，不许分开做。
// ---------------------------------------------------------------------------
// 为什么单独一个工厂：`createHistory(store)` 建出来的日志是空的，`record()` 碰到未登记的 key
// 会抛错。于是「建日志」和「按 SESSION_SLOTS 登记 applier」必须成对发生，而这个循环一旦被
// 复制到第二个地方（运行时装配一份、测试夹具一份），就会出现「有账本但记不进去」的日志。
// 实测过这个失败模式：插件测试的假 ctx 拿了裸 createHistory，7 条用例在第一次写入时全红。
// 收成一个工厂之后，拿到 History 就必然是登记好的。

import { createHistory, type History, type Store } from '@einfach/core'
import { SESSION_SLOTS, SESSION_SLOT_KEYS } from './sessionSlots'

/**
 * 为一个会话 store 建一本登记完备的事务日志。
 *
 * 穷举登记而不是按需登记：漏一个槽位不会静默失效，而是在第一次写它时当场抛，
 * 这正是想要的方向 —— 记一笔无法回放的账比抛错糟得多。
 */
export function createSessionHistory(store: Store): History {
  const history = createHistory(store)
  for (const key of SESSION_SLOT_KEYS) SESSION_SLOTS[key].registerApplier(history)
  return history
}
