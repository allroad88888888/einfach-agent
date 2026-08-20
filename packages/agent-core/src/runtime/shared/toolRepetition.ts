// ---------------------------------------------------------------------------
// 重复工具调用判据（主 run 的 loopGuardPlugin 与子 run 的 childAgentLoop 共用）
// ---------------------------------------------------------------------------
// 为什么住在 runtime/shared 而不是插件目录：子 run【整个不装插件】（没有 plugin host、没有 hook
// 槽，见 subagents/childAgentLoop.ts），但它同样要回答「这个 agent 是不是在原地打转」。可复用的
// 是【判据】——签名规范化 + 跨轮计数 + 阈值——而不是插件本身；判定结果拿去做什么由两侧各自决定：
//   · 主 run（loopGuardPlugin）：命中即终止 run（status:'error' + trace 'agent.loop_detected'）。
//   · 子 run（childAgentLoop）：不终止（它本来就有 maxTurns 硬上限兜底），只在撞上限的收尾报告里
//     说明「重复了什么」，让父 agent 看得见原因。
//
// 【适用性判定刻意留在调用侧】——判据只负责数，不负责决定哪几轮该数：
//   · 主 run 只在「纯工具轮」（finish_reason=tool_calls + 无正文）上累计，其余轮 reset()：
//     有正文即视为有进展，不该据此把整个 run 判死。
//   · 子 run 不 reset()：它不终止任何东西，只解释一次已经由 maxTurns 决定的收尾；跟着正文清零
//     只会把原因藏起来（子 agent 边说话边重复调同一个工具是最常见的打转形态）。
//   把这条差异做成 reset() 由调用方触发，而不是往判据里加一个 mode 开关。
//
// 本文件的签名规范化与计数逻辑由 loopGuardPlugin.ts 原样搬来（数值、算法、同轮去重、只记第一个
// 达阈值项的次序全部逐字保持），插件侧行为零变化。

import type { ModelToolCall } from '@einfach-agent/ai'
import { parseToolCallArgs } from '../modelTurn'

// 同一工具签名跨轮重复达此次数即判成环（TK8 循环上限保护的一部分）。
export const LOOP_DETECTION_THRESHOLD = 3

/** 一条达到阈值的重复调用：它是什么工具、参数长什么样、重复了多少轮。 */
export interface RepeatedToolCall {
  toolName: string
  callId: string
  args: Record<string, unknown>
  /** 该签名累计出现过的轮数（同一轮内出现多次只算 1）。 */
  repeatedCount: number
}

export interface ToolRepetitionTracker {
  /** 记一轮 tool_calls，返回本轮【第一个】达到阈值的重复项；未达阈值返回 undefined。 */
  observeTurn(toolCalls: readonly ModelToolCall[]): RepeatedToolCall | undefined
  /** 清空跨轮累计（由调用侧按自己的适用性判定触发）。 */
  reset(): void
}

// ---------------------------------------------------------------------------
// 工具调用签名规范化
// ---------------------------------------------------------------------------
// 对象键排序 + 递归规范化，使「同参不同键序」判成同一签名；数组保持原序（顺序是语义）。
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeForSignature(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeForSignature(item))
  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalizeForSignature(value[key])]),
    )
  }
  return value
}

// 简介：把工具参数规范化成稳定字符串签名（键序无关、递归）。永不抛（降级用 String）。
export function normalizedArgsSignature(args: unknown): string {
  try {
    return JSON.stringify(normalizeForSignature(args)) ?? ''
  } catch {
    return String(args)
  }
}

// 简介：`工具名:规范化参数签名` —— 跨轮判重的键。
export function toolCallSignature(toolName: string, args: unknown): string {
  return `${toolName}:${normalizedArgsSignature(args)}`
}

// ---------------------------------------------------------------------------
// 计数本体（跨轮累计状态放闭包，per-run / per-child 隔离）
// ---------------------------------------------------------------------------
// 简介：造一个「重复调用计数器」——闭包里握一份签名计数表，每轮喂 tool_calls、返回达阈值的那条。
// 详情：每次调用都是全新计数，故天然按 run（或按子 run 节点）隔离，无需全局单例、无需手动清理。
export function createToolRepetitionTracker(
  threshold: number = LOOP_DETECTION_THRESHOLD,
): ToolRepetitionTracker {
  // ★ 闭包状态 = 隔离的关键 ★：每个 tracker 实例独占这一份，互不串味。
  const repeatedToolSignatures = new Map<string, number>()

  return {
    observeTurn(toolCalls) {
      let repeated: RepeatedToolCall | undefined
      // 同轮去重：一轮里发出的多个相同签名只算一次重复（并发批量调用不等于打转）。
      const seenThisTurn = new Set<string>()
      for (const toolCall of toolCalls) {
        const parsed = parseToolCallArgs(toolCall.function.arguments)
        // 这里只算签名做重复检测，解析失败降级即可（绝不抛）：用原始字符串参与签名 ——
        // 模型反复重发同一段坏 JSON 一样会被判成重复，而不同的坏 JSON 也不会被误并成一条。
        const signature = parsed.ok
          ? toolCallSignature(toolCall.function.name, parsed.args)
          : `${toolCall.function.name}:raw:${parsed.raw}`
        if (seenThisTurn.has(signature)) continue
        seenThisTurn.add(signature)
        const repeatedCount = (repeatedToolSignatures.get(signature) ?? 0) + 1
        repeatedToolSignatures.set(signature, repeatedCount)
        // 命中后仍要把本轮剩下的调用计进表里，但只记录第一个达阈值的那条。
        if (!repeated && repeatedCount >= threshold) {
          repeated = {
            toolName: toolCall.function.name,
            callId: toolCall.id,
            args: parsed.args,
            repeatedCount,
          }
        }
      }
      return repeated
    },
    reset() {
      repeatedToolSignatures.clear()
    },
  }
}
