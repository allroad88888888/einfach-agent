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

// 简介：当前会话的待保存文件产物。
// 详情：值随 store 隔离——每个 session store 各持一份 PendingArtifact[]，非分桶。
export const pendingArtifactsAtom = atom<PendingArtifact[]>([])

// 简介：当前会话的浏览器卡片。
// 详情：值随 store 隔离——每个 session store 各持一份 BrowserCard[]，非分桶。
export const browserCardsAtom = atom<BrowserCard[]>([])

// 简介：当前会话的 AskUserQuestion 待提交答案（questionId → value）。
// 详情：值随 store 隔离——每个 session store 各持一份 Record，非分桶。
export const pendingQuestionAnswersAtom = atom<Record<string, AskUserAnswerValue>>({})

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
 * 清空该会话的 AskUserQuestion 答案（不可变，置为空对象）。
 * 会话未登记则 no-op（ghost guard）。
 */
export function clearPendingQuestionAnswers(id: string): void {
  if (sessionMissing(id)) {
    return
  }
  getSessionStore(id).store.setter(pendingQuestionAnswersAtom, {})
}
