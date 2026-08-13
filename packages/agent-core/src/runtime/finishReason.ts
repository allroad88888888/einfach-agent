// finish_reason 异常三态的【单一口径】——判据 + 三份用户可见文案。
// ---------------------------------------------------------------------------
// 为什么单独成文（盘点 E2 的处置）：判据原先在 runtime/core/loopHooks.ts、三份文案原先在
// runtime/core/plugins/finishReasonPlugin.ts，于是 loop（toolLoopCycle）、子 Agent
// （subagents/childFinishReason）以及 packages/subagents 都得深挖进「默认插件的实现文件」才能
// 拿到文案——换掉那个插件就一起断。判据与文案本身与「谁来收尾」无关：它们描述的是 provider
// 的 finish_reason 语义，属于 runtime 的中立事实，故落在这里，插件和 loop 一样只是消费方。
// loopHooks 仍原样 re-export 判据，turn-end 契约对插件作者保持完整。

import { finishReasonExtensionFor, finishReasonExtensions } from '@web-agent/ai'

export type AbnormalFinishReason = string

// 简介：finish_reason 是否需要异常终止。
// 详情：标准异常原因和 provider extension 都由同一守卫收敛，避免 loop 与插件各自维护判据。
export function isAbnormalFinishReason(reason: string | null): reason is AbnormalFinishReason {
  return (
    reason === 'length' ||
    reason === 'content_filter' ||
    finishReasonExtensionFor(reason) !== undefined
  )
}

// finish_reason 异常三态的用户可见文案（同一份也回给 model / 进 trace，口径唯一）。
export const FINISH_REASON_ERRORS: Record<string, string> = {
  length: '模型输出触顶被截断（finish_reason=length），本轮回复不完整；请调高 max_tokens 或让模型分段输出',
  content_filter: '模型输出被内容安全策略拦截（finish_reason=content_filter）',
  ...Object.fromEntries(finishReasonExtensions().map(({ reason, error }) => [reason, error])),
}

// ---------------------------------------------------------------------------
// 截断标记的持久化（finish_reason 异常三态）
// ---------------------------------------------------------------------------
// 承载 finishError 的 runAtom【不持久化】（设计如此），而被掐断的半截 assistant 条目是照常
// 进 checkpoint 并落盘的 —— 两者一分家就出两个坑：
//   a) 刷新之后那半截回答在历史里与一条正常回复完全同形，用户看不出模型是被 max_tokens 掐断的；
//   b) 更要紧：这条半截文本会作为历史【在之后每一轮被重发给模型】，模型同样看不到「上文这里
//      被截断过」，很可能把半截推理当成已成立的结论继续往下走。
// 故截断状态必须成为【持久化数据本身】的一部分，落点选在 assistant 条目正文末尾：
//   · 正文是唯一同时进 itemsAtom → checkpoint → 落盘 → 且每轮原样重发给模型的载体，一处改动
//     同时满足 a 和 b。换成 ConversationItem 上的新字段只能满足 a（该字段不进线协议、模型看不见）；
//     换成 assistant 条目内的新字段则会被原样发进 chat/completions 请求体，属于协议外字段，不能碰。
//   · 只在异常三态分支追加，正常轮的条目一个字都不动（不污染）。
//   · revert 语义不变：标注是 items 快照的一部分，回到这一轮就带着标注、回到更早的轮就没有。
export const FINISH_REASON_ITEM_NOTICES: Record<string, string> = {
  length:
    '\n\n> ⚠️ 【系统标注】以上回复因触达输出上限被截断（finish_reason=length），内容不完整。' +
    '其中的推理很可能只进行到一半，不要把它当作已成立的结论直接沿用。',
  content_filter:
    '\n\n> ⚠️ 【系统标注】以上回复被内容安全策略拦截（finish_reason=content_filter），内容不完整。',
  ...Object.fromEntries(finishReasonExtensions().map(({ reason, itemNotice }) => [reason, itemNotice])),
}

// 「仅含标注」独立条目专用文案 —— 与上面那份【分开】，因为「以上」的指代对象不同。
// 上面那份是拼在正文【之后】的，「以上回复」指同一条消息里前面那段文字，成立；
// 而没有正文的异常终止在非流式下需单独成条，
// 此时它上面一条消息是【用户的提问】—— 再说「以上回复」就指到用户身上了。
// 重发历史时模型看到 user → assistant('以上回复被拦截')，很可能理解成「用户的输入被拦截了」，
// 与「让模型知道自己上一轮输出出了什么事」的目标正好相反，所以主语必须换成「本轮回复」。
export const FINISH_REASON_STANDALONE_NOTICES: Record<string, string> = {
  length:
    '> ⚠️ 【系统标注】本轮回复因触达输出上限被截断（finish_reason=length），未产生任何内容。',
  content_filter:
    '> ⚠️ 【系统标注】本轮回复被内容安全策略拦截（finish_reason=content_filter），未产生任何内容。',
  ...Object.fromEntries(finishReasonExtensions().map(({ reason, standaloneNotice }) => [reason, standaloneNotice])),
}
