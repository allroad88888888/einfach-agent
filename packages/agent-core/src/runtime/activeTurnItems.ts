// 活动轮的对话切片 —— 从 items 里切出「属于当前这一轮用户输入」的那一段。
// ---------------------------------------------------------------------------
// 本文件从原 runCheckpoints.ts 拆出。那里另有三个函数随用户 undo 一起删除：
// persistStoppedRunCheckpoint / latestUserInput（只为 checkpoint label 供料）、
// 以及 closeUnresolvedToolCalls（删除时全仓零消费方）。

import { runAtom, itemsAtom } from '../state/sessionAtoms'
import type { CoreInstance } from './core/coreInstance'

/**
 * 返回属于当前用户轮的那段对话。
 * 优先按 run 记录的 turnId 锚定；没有锚点时退化为「从最后一条 user 消息起」。
 */
export function currentTurnItems(sessionId: string, core: CoreInstance) {
  const store = core.getSessionStore(sessionId).store
  const items = store.getter(itemsAtom)
  const turnId = store.getter(runAtom)?.turnId
  if (turnId) {
    const anchoredStart = items.findIndex((entry) => entry.id === turnId)
    if (anchoredStart >= 0) return items.slice(anchoredStart)
  }
  let start = 0
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].item.role === 'user') {
      start = index
      break
    }
  }
  return items.slice(start)
}
