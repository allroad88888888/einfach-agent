// 输入框里还没发出去的那段文字。
// ---------------------------------------------------------------------------
// 这是**纯 UI 态**，住在 UI store 里，刷新即丢 —— 明确裁决，不是遗漏。
//
// 它曾经是 `SESSION_SLOTS.composerDraft`，进恢复快照。当时写下的理由是「回退/撤回会把用户原话
// 从 items 截断再放回输入框，那一刻草稿是这段用户内容的唯一副本」。核对代码：
// `runtime/commands/planCommands.ts` 的 `rollbackPlanStage` 只截断 items 并立一条提示，
// **从不回写草稿** —— 那个机制在实现里根本不存在，所以草稿从来就不是任何内容的唯一副本。
//
// 将来若要恢复「刷新不丢草稿」，正确做法是让 UI store 自己落盘，而不是把它塞回会话快照：
// 草稿是逐击键写的，而快照只在耐久性栅栏落盘，两者时点对不上。

import { atom } from '@einfach/core'

export const composerDraftAtom = atom<string>('')
