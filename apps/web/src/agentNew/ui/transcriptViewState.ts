// 消息列表里「思考过程」分组的展开/折叠偏好。
// ---------------------------------------------------------------------------
// 纯渲染态：住 UI store，只由 MessageList 读写，刷新回默认视图。
// 与 messageWindowModel.ts 的滑动窗口是两件事——那个管「渲染哪一段」，这个管「某一组展不展开」。

import { atom } from '@einfach/core'

/** group key → 是否展开。 */
export const expandedTranscriptGroupsAtom = atom<Record<string, boolean>>({})
