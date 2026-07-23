// 顶层「会话列表」atom 的【纯定义】—— 零 runtime 依赖，是破环用的地基层。
// ---------------------------------------------------------------------------
// 背景（实例化 · 第 1 期）：coreInstance 需要 rootStore（=该实例的会话列表 store），
//   而 rootStore.ts 现在要从 defaultCore（来自 coreInstance）取 store —— 若 sessionsAtom /
//   activeSessionIdAtom 仍定义在 rootStore.ts，且 coreInstance 又要引用它们，就成环。
//   解法：把这些 atom 的【定义】沉到本文件（只依赖 @einfach/core 的 atom + 类型），
//   coreInstance / rootStore 都从这里 import；rootStore.ts 再原样 re-export 它们，
//   所以全仓 `import { sessionsAtom } from '../state/rootStore'` 照旧有效，一行不用改。
//
// 契约（CHECKPOINT-STATE-PLAN §1 C3）：这里只放「跨会话」的会话列表 + 当前会话 id，
//   严禁出现任何 Record<sessionId, 会话内容> 分桶（那是各会话自己 store 的事）。

import { atom } from '@einfach/core'
import type { SessionMeta } from './core.type'

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
