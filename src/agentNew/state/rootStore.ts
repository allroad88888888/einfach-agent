// 顶层「会话列表」store —— 全局唯一，只管跨会话的东西（会话元信息 + 当前会话 id）。
// ---------------------------------------------------------------------------
// 契约（CHECKPOINT-STATE-PLAN §1 C3）：store 架构是「每会话一个独立 store + 顶层 rootStore」。
//   · 顶层 rootStore（本文）：全局唯一，只存会话列表 sessionsAtom + 当前会话 activeSessionIdAtom。
//   · 会话内容（items / run / checkpoints）：不在这里，由每会话自己的 store 持有（见 P3/P4）。
// 所以本文严禁出现任何 Record<sessionId, _> 的会话内容分桶，也严禁导出全局 agentStore 单例。

import { atom, createStore, type Store } from '@einfach/core'
import type { SessionMeta } from './core.type'

// 简介：全局唯一顶层 store。
// 详情：只承载「跨会话」的状态（会话列表 + 当前会话 id）。会话内容各归各的会话 store。
export const rootStore: Store = createStore()

// 简介：会话列表元信息（id → SessionMeta）。
// 详情：会话是否存在的权威事实。写入器的 ghost guard 就是查这里有没有登记（见 P5 C7）。
export const sessionsAtom = atom<Record<string, SessionMeta>>({})

// 简介：当前激活的会话 id。
// 详情：空串表示「无激活会话」。UI 切会话 = 改这个 + 切到对应会话 store。
export const activeSessionIdAtom = atom<string>('')

// 简介：当前会话的元信息（派生）。
// 详情：由 sessionsAtom + activeSessionIdAtom 组合得出；activeSessionId 指向未登记会话时为 undefined。
export const activeSessionMetaAtom = atom(
  (get): SessionMeta | undefined => get(sessionsAtom)[get(activeSessionIdAtom)],
)

// 简介：复位顶层 store（仅测试用）。
// 详情：把会话列表清空、当前会话 id 置空串，让全局单例 rootStore 在用例间互不污染。
export function resetRootStore(): void {
  rootStore.setter(sessionsAtom, {})
  rootStore.setter(activeSessionIdAtom, '')
}
