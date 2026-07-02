// TK5 瞬态 atom —— 会话 store 内共享单例 key（值随 store 隔离，绝不分桶）。
// ---------------------------------------------------------------------------
// 对齐旧 src/agent/state 的 pendingArtifacts / browserCards / pendingQuestionAnswers，
// 但按 agentNew 既定架构（sessionAtoms 范式，C3）落到「每会话一个 store」：
//   · 三个 atom 只是共享 key，值真正存在各自 session store 里 —— 天然隔离，
//     无需也禁止把它们做成 `Record<sessionId, T>` 分桶。
//   · 都是「临时 UI 产物」，不进持久化快照（对齐旧 D2 语义）。
// 写入器沿用 sessionWriters 范式（C7）：内部取 getSessionStore(id).store；
// 先做 ghost guard（会话未在 rootStore 登记 → no-op，防给幽灵会话写内容）；
// 所有更新不可变（替换数组/对象，C4）。

import { atom } from '@einfach/core'
import { rootStore, sessionsAtom } from './rootStore'
import { getSessionStore } from './sessionStore'

// save_file 工具暂存、等用户手势落盘的文件产物（临时 UI 态，不持久化）。
export interface PendingArtifact {
  id: string
  filename: string
  content: string
  mimeType?: string
}

// browser_action render_card 渲染进 transcript 的卡片（临时 UI 态，不持久化）。
export interface BrowserCard {
  id: string
  createdAt: number
  title: string
  body?: string
}

// AskUserQuestion 单个答案值（照抄旧 types 语义）。
export type AskUserAnswerValue = string | string[] | boolean

// 工具进度条目（临时 UI 态，不持久化）：显示「某个工具调用正在干啥」。
// callId = 该 tool_call 的 id（唯一），toolName 便于 UI 标注，text 是工具经 ctx.progress 给的文案。
export interface ToolActivity {
  callId: string
  toolName: string
  text: string
}

// 简介：当前会话的待保存文件产物。
// 详情：值随 store 隔离——每个 session store 各持一份 PendingArtifact[]，非分桶。
export const pendingArtifactsAtom = atom<PendingArtifact[]>([])

// 简介：当前会话的浏览器卡片。
// 详情：值随 store 隔离——每个 session store 各持一份 BrowserCard[]，非分桶。
export const browserCardsAtom = atom<BrowserCard[]>([])

// 简介：当前会话的 AskUserQuestion 待提交答案（questionId → value）。
// 详情：值随 store 隔离——每个 session store 各持一份 Record，非分桶。
export const pendingQuestionAnswersAtom = atom<Record<string, AskUserAnswerValue>>({})

// 简介：当前会话正在跑的工具进度（按 callId）。
// 详情：值随 store 隔离；harness 经 ctx.progress 上写、工具跑完清掉。UI 读它渲染「工具正在干啥」。
export const toolActivityAtom = atom<ToolActivity[]>([])

// 简介：本 session「一律允许」的危险工具名集合（S4-B）。
// 详情：用户在确认卡片勾选「本 session 一律允许该工具」后写入；tool 循环命中即跳过后续确认。
//   值随 store 隔离；临时 UI 态，不持久化（刷新即恢复「每次都确认」的安全默认）。
export const alwaysAllowedToolsAtom = atom<string[]>([])

// ghost guard：会话未在 rootStore 登记 → 后续写入应 no-op（C7）。
function sessionMissing(id: string): boolean {
  return !rootStore.getter(sessionsAtom)[id]
}

/**
 * 往该会话暂存一个 save_file 文件产物（不可变，产生新数组）。
 * 会话未登记则 no-op（ghost guard）。
 */
export function addPendingArtifact(id: string, artifact: PendingArtifact): void {
  if (sessionMissing(id)) {
    return
  }
  getSessionStore(id).store.setter(pendingArtifactsAtom, (prev) => [...prev, artifact])
}

/**
 * 从该会话移除指定 artifactId 的 save_file 文件产物（不可变，产生新数组）。
 * 会话未登记则 no-op（ghost guard）；artifactId 不存在时数组内容不变、不崩。
 */
export function removePendingArtifact(id: string, artifactId: string): void {
  if (sessionMissing(id)) {
    return
  }
  getSessionStore(id).store.setter(pendingArtifactsAtom, (prev) =>
    prev.filter((a) => a.id !== artifactId),
  )
}

/**
 * 往该会话追加一张浏览器卡片（不可变，产生新数组）。
 * 会话未登记则 no-op（ghost guard）。
 */
export function addBrowserCard(id: string, card: BrowserCard): void {
  if (sessionMissing(id)) {
    return
  }
  getSessionStore(id).store.setter(browserCardsAtom, (prev) => [...prev, card])
}

/**
 * 丢弃该会话中 createdAt 晚于 `createdAt` 的浏览器卡片（不可变，产生新数组）。
 * 会话未登记则 no-op（ghost guard）。
 * 用途：截断式回退时，browserCards 不进 checkpoint 快照，需按回退点时间戳把「被丢弃轮次」
 *   产生的卡片一并剪掉，否则回退后仍会渲染已废弃轮的卡片（codex P2）。保留 `<=` 即回退到的
 *   那一轮（及更早）的卡片留下，之后的剪掉。
 */
export function pruneBrowserCardsAfter(id: string, createdAt: number): void {
  if (sessionMissing(id)) {
    return
  }
  getSessionStore(id).store.setter(browserCardsAtom, (prev) =>
    prev.filter((card) => card.createdAt <= createdAt),
  )
}

/**
 * 记录该会话某个 questionId 的答案（不可变，替换成新对象）。
 * 会话未登记则 no-op（ghost guard）。
 */
export function setPendingQuestionAnswer(
  id: string,
  questionId: string,
  value: AskUserAnswerValue,
): void {
  if (sessionMissing(id)) {
    return
  }
  getSessionStore(id).store.setter(pendingQuestionAnswersAtom, (prev) => ({
    ...prev,
    [questionId]: value,
  }))
}

/**
 * 读取该会话已收集的 AskUserQuestion 答案（无答案时为空对象）。
 */
export function getPendingQuestionAnswers(id: string): Record<string, AskUserAnswerValue> {
  return getSessionStore(id).store.getter(pendingQuestionAnswersAtom)
}

/**
 * 写入/更新某工具调用的进度条目（按 callId upsert，不可变）。会话未登记则 no-op（ghost guard）。
 */
export function upsertToolActivity(id: string, activity: ToolActivity): void {
  if (sessionMissing(id)) {
    return
  }
  getSessionStore(id).store.setter(toolActivityAtom, (prev) => {
    const index = prev.findIndex((entry) => entry.callId === activity.callId)
    if (index < 0) return [...prev, activity]
    const next = [...prev]
    next[index] = activity
    return next
  })
}

/**
 * 清掉某工具调用的进度条目（该工具跑完时）。会话未登记则 no-op（ghost guard）。
 */
export function removeToolActivity(id: string, callId: string): void {
  if (sessionMissing(id)) {
    return
  }
  getSessionStore(id).store.setter(toolActivityAtom, (prev) => prev.filter((entry) => entry.callId !== callId))
}

/**
 * 清空该会话的 AskUserQuestion 答案（不可变，置为空对象）。
 * 会话未登记则 no-op（ghost guard）。
 */
export function clearPendingQuestionAnswers(id: string): void {
  if (sessionMissing(id)) {
    return
  }
  getSessionStore(id).store.setter(pendingQuestionAnswersAtom, {})
}

/**
 * 把某危险工具加进该会话的「一律允许」集合（S4-B，去重，不可变）。会话未登记则 no-op（ghost guard）。
 */
export function addAlwaysAllowedTool(id: string, toolName: string): void {
  if (sessionMissing(id)) {
    return
  }
  getSessionStore(id).store.setter(alwaysAllowedToolsAtom, (prev) =>
    prev.includes(toolName) ? prev : [...prev, toolName],
  )
}

/**
 * 该会话是否已「一律允许」某危险工具（S4-B）。会话未登记 → 取到 [] → false。
 */
export function isToolAlwaysAllowed(id: string, toolName: string): boolean {
  return getSessionStore(id).store.getter(alwaysAllowedToolsAtom).includes(toolName)
}
