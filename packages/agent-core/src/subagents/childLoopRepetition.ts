// ---------------------------------------------------------------------------
// 子 run 撞 maxTurns 时的「它在重复什么」
// ---------------------------------------------------------------------------
// 子 run【整个不装插件】，所以主 run 的 loopGuardPlugin 对它无效；它只有 childAgentLoop 里的
// maxTurns 硬上限兜底，而 `exceeded maxTurns` 这句话不说明它为什么走到那一步。本文件复用
// runtime/shared/toolRepetition 的**判据**（不是插件）在子循环里数重复调用，并把结论写成中文，
// 让父 agent 拿到的报告能回答「它在重复什么」——重复的工具名、参数、重复轮数。
//
// 两点与主 run 刻意不同（都是「解释」与「熔断」的差别）：
//   1. 【不清零】主 run 在有正文的轮次会清空计数（有正文=有进展，不该据此判死一个 run）；子 run
//      只是解释一次已由 maxTurns 决定的收尾，跟着正文清零只会把原因藏起来——边说话边反复调同一个
//      工具恰恰是最常见的打转形态。
//   2. 【不终止】判据在这里从不改变控制流：命中与否，子 run 都照原样跑到 maxTurns。
//
// 信息落在哪一层：末轮是**强制合成轮**（tools=[]、tool_choice='none'），子 run 撞上限时通常从那一轮
// 正常返回文本、状态 done。所以说明必须并进 `ChildAgentResult.summary`——它是父 agent 经
// join_agent / observe_agent 真正读到的那份文本，也是 finalizeChildResult 写进归档 result 文件与
// child_finished 事件的同一份。只塞进抛出的异常串是不够的：那条路只有「合成轮里模型还在调工具」
// 才会走到。

import type { ModelToolCall } from '@einfach-agent/ai'
import {
  createToolRepetitionTracker,
  normalizedArgsSignature,
  type RepeatedToolCall,
} from '../runtime/shared/toolRepetition'

// 报告里回显参数的长度上限：够认出「是不是同一个调用」即可，不喂给父 agent 一整份大参数。
const ARGS_PREVIEW_LIMIT = 160

export interface ChildRepetitionWatch {
  /** 记一轮模型请求的 tool_calls；子 run 从不清零，故空数组是无害的 no-op。 */
  observeTurn(toolCalls: readonly ModelToolCall[]): void
  /** 到目前为止重复得最狠的那条（未达阈值时 undefined）。 */
  repeated(): RepeatedToolCall | undefined
}

/** 造一份子 run 专用的重复调用观测（每个子节点一份，闭包隔离）。 */
export function createChildRepetitionWatch(): ChildRepetitionWatch {
  const tracker = createToolRepetitionTracker()
  let worst: RepeatedToolCall | undefined
  return {
    observeTurn(toolCalls) {
      const hit = tracker.observeTurn(toolCalls)
      // 只向上刷新：同一签名在后续轮次会带来更大的 repeatedCount，报告要给最终值而不是首次命中值。
      if (hit && (!worst || hit.repeatedCount > worst.repeatedCount)) worst = hit
    },
    repeated: () => worst,
  }
}

function argsPreview(args: Record<string, unknown>): string {
  // 复用签名那份规范化序列化（永不抛），报告里的参数与判重用的是同一个口径。
  const text = normalizedArgsSignature(args)
  return text.length > ARGS_PREVIEW_LIMIT ? `${text.slice(0, ARGS_PREVIEW_LIMIT)}…` : text
}

/** 「它在重复什么」的中文小节；没有达到阈值的重复项时返回空串（收尾文案原样不变）。 */
function repetitionClause(watch: ChildRepetitionWatch): string {
  const repeated = watch.repeated()
  if (!repeated) return ''
  return `【疑似死循环】它在 ${repeated.repeatedCount} 轮里反复以完全相同的参数调用工具 `
    + `${repeated.toolName}（参数：${argsPreview(repeated.args)}），没有取得新进展。`
}

/**
 * 强制合成轮产出的最终 summary：无重复时原样返回；有重复时把原因接在结论后面。
 * 这是父 agent 真正读到的那一层文本。
 */
export function childExhaustionSummary(
  summary: string,
  watch: ChildRepetitionWatch,
  maxTurns: number,
): string {
  const clause = repetitionClause(watch)
  if (!clause) return summary
  return `${summary.trim()}\n\n${clause}以上结论产自第 ${maxTurns} 轮的强制收尾，可能不完整；`
    + '若仍需该任务，建议换一个更具体的目标重新委派。'
}

/**
 * 合成轮里模型仍在调工具时的收尾错误：子 run 由此转成 failed，message 同时进 summary 与 error。
 * 保留原英文串作为可检索标识，前面补上中文说明与重复原因。
 */
export function childMaxTurnsError(watch: ChildRepetitionWatch, maxTurns: number): Error {
  const clause = repetitionClause(watch)
  return new Error(
    `子 agent 用尽 ${maxTurns} 轮上限仍未给出结论（child agent exceeded maxTurns ${maxTurns}）。${clause}`,
  )
}
