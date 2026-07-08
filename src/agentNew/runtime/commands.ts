// P-R3：runtime 命令 API —— UI ↔ runtime 的唯一边界。
// ---------------------------------------------------------------------------
// 契约（RUNTIME-UI-PLAN §1）：
//   · U1 runtime/UI 隔离：UI 只做两件事 —— 读 atom + 调这里导出的命令。UI 绝不直接
//     setter atom / import writers / 碰 store 实例；这些命令是唯一入口边界。
//   · U2 命令不收 store：每个命令都不接 `store` 参数，内部自取 rootStore /
//     getSessionStore(activeId)。UI 拿不到、也不需要 store 引用。
//   · U7 signal 全穿透 + 失败降级：sendMessage 起 run 时把 abort signal 穿到 model；
//     model 失败由 runSession 内部降级（不抛崩 UI）。
// 本文只编排 rootStore / sessionStore / abortRegistry / modelRun / checkpointWriters，
// 不 import 任何 UI（U1）。

import { rootStore, sessionsAtom, activeSessionIdAtom } from '../state/rootStore'
import { createSessionStore, getSessionStore, dropSessionStore } from '../state/sessionStore'
import { itemsAtom, runAtom, checkpointsAtom } from '../state/sessionAtoms'
import { appendItem, patchRun, setItems, setRun } from '../state/sessionWriters'
import {
  getPendingQuestionAnswers,
  clearPendingQuestionAnswers,
  setPendingQuestionAnswer,
  removePendingArtifact,
  pruneBrowserCardsAfter,
  pruneRuntimeTranscriptEventsAfter,
  addAlwaysAllowedTool,
  setComposerDraft,
  setWithdrawnTurnNotice,
} from '../state/transientAtoms'
import type { AskUserAnswerValue } from '../state/transientAtoms'
import { jumpToCheckpoint } from '../state/checkpointWriters'
import { beginRun, abortRun, endRun } from './abortRegistry'
import { runSession, runToolLoop } from './modelRun'
import { persistSessions, persistDeleteSession, persistTruncate } from './persistenceBridge'
import { newId } from './newId'
import type { ModelSettings, SessionMeta, ConversationItem } from '../state/core.type'
import { DEFAULT_DEEPSEEK_MODEL } from '../api/deepseek'
import { addEvent, getActiveSpan, runTraceKey } from '../observability/trace'
import { isDangerousTool } from './dangerousTools'

// ===========================================================================
// 模块级配置注入 —— apiKey 来源（兼顾可测）
// ===========================================================================
// main.tsx 启动时用 env 注入真 key（configureCommands）；测试注入 fake key / fetchImpl。
// 命令不收 store（U2），apiKey 也不该由 UI 逐次传入 —— 集中在此模块级配置。
let runtimeConfig: { deepseekApiKey: string; glmApiKey: string; fetchImpl?: typeof fetch } = {
  deepseekApiKey: '',
  glmApiKey: '',
}

// 简介：注入/更新运行时配置（apiKey / 可选 fetchImpl）。
// 详情：浅合并，只覆盖传入的字段；未传的保持原值。
export function configureCommands(cfg: Partial<typeof runtimeConfig>): void {
  runtimeConfig = { ...runtimeConfig, ...cfg }
}

// ===========================================================================
// 会话命令
// ===========================================================================

// 会话默认标题 —— newSession 的兜底名，也是自动标题（TT1）判断「用户尚未取名」的哨兵值。
export const DEFAULT_SESSION_TITLE = '新对话'

// 简介：从用户输入派生会话标题（TT2，纯函数）。
// 详情：压缩空白（连串空白折成单空格 + 去首尾）→ Array.from 按 code point 截前 12 字
//   （防 emoji/增补平面字符被从代理对中间截断成乱码）→ 截断则加 …。
//   派生为空（纯空白输入）返回空串，由调用方决定保留默认名。
export function deriveSessionTitle(input: string): string {
  const compact = input.replace(/\s+/g, ' ').trim()
  if (!compact) return ''
  const chars = Array.from(compact)
  if (chars.length <= 12) return compact
  return `${chars.slice(0, 12).join('')}…`
}

// 简介：给指定会话改名（TT3）—— ghost guard + 不可变更新 + updatedAt 前进 + 落盘。
// 详情：照 setWorkspaceRoot 范式。trim 后空串 → no-op（编辑框取消语义，保留原名）；
//   超长入参按 code point 截 48 字防爆列表。自动标题（sendMessage/TT1）内部复用本命令。
export function renameSession(id: string, title: string): void {
  const trimmed = title.trim()
  if (!trimmed) return
  const next = Array.from(trimmed).slice(0, 48).join('')
  let changed = false
  rootStore.setter(sessionsAtom, (prev) => {
    const meta = prev[id]
    if (!meta) return prev // ghost guard：会话未登记 → no-op
    changed = true
    return { ...prev, [id]: { ...meta, title: next, updatedAt: Date.now() } }
  })
  if (changed) persistSessions() // D-4：会话元信息变更 → 覆盖式落盘（fire-and-forget）。
}

// 简介：新建会话 → 登记 rootStore.sessionsAtom → 建每会话 store → 设为 active，返回 id。
// 详情：默认 settings 为 deepseek + 默认模型；opts.settings / opts.title 可覆盖。
export function newSession(opts?: { title?: string; settings?: ModelSettings }): string {
  const id = newId()
  const settings: ModelSettings = opts?.settings ?? {
    vendor: 'deepseek',
    model: DEFAULT_DEEPSEEK_MODEL,
  }
  const now = Date.now()
  const meta: SessionMeta = {
    id,
    title: opts?.title ?? DEFAULT_SESSION_TITLE,
    settings,
    createdAt: now,
    updatedAt: now,
  }
  rootStore.setter(sessionsAtom, (prev) => ({ ...prev, [id]: meta }))
  createSessionStore(id)
  rootStore.setter(activeSessionIdAtom, id)
  persistSessions() // D-4：会话列表变更 → 覆盖式落盘（fire-and-forget）。
  return id
}

// 简介：切换当前激活会话。
export function selectSession(id: string): void {
  rootStore.setter(activeSessionIdAtom, id)
}

// 简介：删除会话 —— 不可变从 sessionsAtom 删 id + 丢弃其 store。
// 详情：若删的是当前 active，active 落到剩余任一 id（Object.keys 第一个）或空串。
export function removeSession(id: string): void {
  // 先中断该会话可能在跑的 run（否则 abortRegistry 的 controller 泄漏、model 请求白跑）。
  abortRun(id)
  rootStore.setter(sessionsAtom, (prev) => {
    const next = { ...prev }
    delete next[id]
    return next
  })
  dropSessionStore(id)
  if (rootStore.getter(activeSessionIdAtom) === id) {
    const remaining = Object.keys(rootStore.getter(sessionsAtom))
    rootStore.setter(activeSessionIdAtom, remaining[0] ?? '')
  }
  // D-4：会话列表变更 → 覆盖式落盘；被删会话的历史 checkpoint 单独清盘（均 fire-and-forget）。
  persistSessions()
  persistDeleteSession(id)
}

// 简介：给当前 active 会话绑定 workspace 根目录（S4-A）—— 不可变改 SessionMeta.workspaceRoot + 落盘。
// 详情：无 active / 会话未登记 → no-op（U2 自取 active）。trim 后空串视为「清空」（存 undefined →
//   toolContext 不透传 → Rust 走 git root 兜底）。updatedAt 前进（R2 一致性），随会话列表覆盖式落盘。
export function setWorkspaceRoot(root: string): void {
  const id = rootStore.getter(activeSessionIdAtom)
  if (!id) return
  const trimmed = root.trim()
  let changed = false
  rootStore.setter(sessionsAtom, (prev) => {
    const meta = prev[id]
    if (!meta) return prev // ghost guard：会话未登记 → no-op
    changed = true
    return {
      ...prev,
      [id]: { ...meta, workspaceRoot: trimmed ? trimmed : undefined, updatedAt: Date.now() },
    }
  })
  if (changed) persistSessions() // D-4：会话元信息变更 → 覆盖式落盘（fire-and-forget）。
}

// ===========================================================================
// 运行命令
// ===========================================================================

// 简介：对当前 active 会话起一轮 run（U5 单轮切片）。
// 详情：无 active / 空输入 / 会话未登记 → no-op。apiKey 按会话 vendor 取（glm→glmApiKey，
//   否则 deepseekApiKey）。beginRun 拿 signal（U7 穿透）；runSession 失败内部降级；
//   finally 里 endRun 清理（只删自己那个 controller）。
export function sendMessage(input: string): void {
  const id = rootStore.getter(activeSessionIdAtom)
  if (!id || !input.trim()) return
  const meta = rootStore.getter(sessionsAtom)[id]
  if (!meta) return

  // 忙碌守卫（codex P2）：当前会话 run 正在跑 / 等工具 / 等用户回答时，不接受新输入。否则新 run
  //   会顶掉未完成的旧 run；尤其 waiting_user 时，上一条 assistant 的 ask_user tool_call 尚无
  //   对应 tool result，重发会构成非法 tool-call 序列被接口拒。UI（Composer）也会锁输入，这里是
  //   命令层兜底（防任何编程路径）。
  const status = getSessionStore(id).store.getter(runAtom)?.status
  if (
    status === 'running' ||
    status === 'awaiting_tool' ||
    status === 'waiting_user' ||
    status === 'waiting_confirmation'
  )
    return

  // 自动标题（TT1）：标题仍为默认值时，用本条输入派生一次标题（复用 renameSession 走
  //   ghost guard/updatedAt/落盘）。用户改过名（≠默认）绝不覆盖；同会话第二条消息时标题
  //   已非默认，天然不再触发。派生为空（理论上上面已挡空输入）→ 保留默认名。
  if (meta.title === DEFAULT_SESSION_TITLE) {
    const derived = deriveSessionTitle(input)
    if (derived) renameSession(id, derived)
  }

  const apiKey = meta.settings.vendor === 'glm' ? runtimeConfig.glmApiKey : runtimeConfig.deepseekApiKey
  const signal = beginRun(id)
  void runSession(id, input, { signal, apiKey, fetchImpl: runtimeConfig.fetchImpl }).finally(() =>
    endRun(id, signal),
  )
}

// 简介：esc —— 中断当前 active 会话正在跑的 run。
export function stopRun(): void {
  const id = rootStore.getter(activeSessionIdAtom)
  if (id) abortRun(id)
}

const SIDE_EFFECT_TOOL_NAMES = new Set(['run_task'])

function currentTurnStartIndex(items: ConversationItem[]): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i].item.role === 'user') return i
  }
  return -1
}

function currentTurnHasSideEffects(items: ConversationItem[]): boolean {
  for (const { item } of items) {
    if (item.role !== 'assistant') continue
    for (const toolCall of item.tool_calls ?? []) {
      const name = toolCall.function.name
      if (isDangerousTool(name) || SIDE_EFFECT_TOOL_NAMES.has(name)) return true
    }
  }
  return false
}

// 简介：撤回当前未完成轮并把该轮用户输入放回 Composer 草稿。
// 详情：仅处理 run.status==='stopped' 的当前 active 会话；成功完成的轮次走 checkpoint 回退，不走这里。
//   该操作只撤回对话 transcript，不承诺撤销已执行的外部副作用；若本轮出现过危险/执行类工具，会写入提示。
export function withdrawCurrentTurnToDraft(): void {
  const id = rootStore.getter(activeSessionIdAtom)
  if (!id) return
  const store = getSessionStore(id).store
  const run = store.getter(runAtom)
  if (run?.status !== 'stopped') return

  const items = store.getter(itemsAtom)
  const start = currentTurnStartIndex(items)
  if (start < 0) return
  const user = items[start].item
  if (user.role !== 'user') return

  abortRun(id)
  const turnItems = items.slice(start)
  const sideEffects = currentTurnHasSideEffects(turnItems)
  const cutoffCreatedAt = items[start].createdAt
  setItems(id, items.slice(0, start))
  setRun(id, undefined)
  setComposerDraft(id, user.content)
  pruneBrowserCardsAfter(id, cutoffCreatedAt - 1)
  pruneRuntimeTranscriptEventsAfter(id, cutoffCreatedAt - 1)
  setWithdrawnTurnNotice(id, {
    id: newId(),
    createdAt: Date.now(),
    text: sideEffects
      ? '已撤回本轮对话并放回输入框；本轮已触发过工具，外部副作用不会被自动撤销。'
      : '已撤回本轮对话并放回输入框。',
    sideEffects,
  })
}

// 从对话历史里取「最后一条 assistant」的 ask_user_question tool_call id（找不到返回 undefined）。
// 该 id 即暂停时未回填的 ask_user ToolItem 的 tool_call_id，resume 用它把答案回填给 model。
function findAskUserToolCallId(items: ConversationItem[]): string | undefined {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i].item
    if (item.role === 'assistant') {
      return item.tool_calls?.find((toolCall) => toolCall.function.name === 'ask_user_question')?.id
    }
  }
  return undefined
}

// 简介：ask_user 恢复（T-7/TK7）—— 用户填完答案后续跑 pending run。
// 详情：仅当当前 active 会话 run 处于 waiting_user 时生效。从 itemsAtom 找最后一条 assistant 的
//   ask_user_question tool_call（取其 id=tool_call_id）；找不到则容错清 pendingQuestion + 落回
//   running 后返回（不续跑）。否则读并清 pendingQuestionAnswers → 回填 ask_user 的 ToolItem（把
//   {answers} 当 tool result）→ 落回 running + 清 pendingQuestion → 复用 pending run 的 runId、
//   beginRun 拿新 signal，走 runToolLoop 续跑（apiKey 按会话 vendor 取，与 sendMessage 同逻辑；
//   finally endRun 清理）。
export function resumeWithAnswers(): void {
  const id = rootStore.getter(activeSessionIdAtom)
  if (!id) return
  const run = getSessionStore(id).store.getter(runAtom)
  if (run?.status !== 'waiting_user') return

  // 找待回填的 ask_user tool_call id。
  const toolCallId = findAskUserToolCallId(getSessionStore(id).store.getter(itemsAtom))
  // 容错：找不到 ask_user 调用（异常/被回退过）→ 清 pendingQuestion + 落回 running，不续跑。
  if (!toolCallId) {
    patchRun(id, { status: 'running', pendingQuestion: undefined })
    return
  }

  // 读答案 + 清答案（避免旧答案污染下一次等待用户输入）。
  const answers = getPendingQuestionAnswers(id)
  clearPendingQuestionAnswers(id)
  addEvent('agent.resume.answers', {
    span: getActiveSpan(runTraceKey(id, run.runId)),
    attrs: { sessionId: id, runId: run.runId, callId: toolCallId, answers_count: Object.keys(answers).length },
  })

  // 回填 ask_user 的 ToolItem：把 {answers} 作为 tool result 回给 model。
  appendItem(id, {
    id: newId(),
    createdAt: Date.now(),
    item: { role: 'tool', tool_call_id: toolCallId, content: JSON.stringify({ answers }) },
  })

  // 落回 running + 清 pendingQuestion，复用 pending run 的 runId 续跑同一条 run。
  patchRun(id, { status: 'running', pendingQuestion: undefined })

  const meta = rootStore.getter(sessionsAtom)[id]
  const apiKey = meta?.settings.vendor === 'glm' ? runtimeConfig.glmApiKey : runtimeConfig.deepseekApiKey
  const signal = beginRun(id)
  void runToolLoop(id, run.runId, { signal, apiKey, fetchImpl: runtimeConfig.fetchImpl }).finally(() =>
    endRun(id, signal),
  )
}

// 简介：危险工具确认恢复（S4-B）—— 用户在确认卡片点「允许」/「拒绝」后续跑 pending run。镜像 resumeWithAnswers。
// 详情：仅当当前 active 会话 run 处于 waiting_confirmation 时生效。取 pendingToolConfirmation；缺失则容错清空 +
//   落回 running 后返回（不续跑）。approved=true → 复用 pending run 的 runId，把该危险工具作为 resumeToolCall
//   传进 runToolLoop（循环开头执行它、回填结果，再进正常多轮）；always=true 则先把该工具记进本 session
//   「一律允许」集合（后续不再确认）。approved=false → 给该 tool_call 回填 {error} result 后重入循环，
//   让 model 据此改道。apiKey 按会话 vendor 取（与 sendMessage 同逻辑）；finally endRun 清理。
export function confirmTool(approved: boolean, always?: boolean): void {
  const id = rootStore.getter(activeSessionIdAtom)
  if (!id) return
  const run = getSessionStore(id).store.getter(runAtom)
  if (run?.status !== 'waiting_confirmation') return

  const pending = run.pendingToolConfirmation
  // 容错：无 pending（异常/被回退过）→ 清 pendingToolConfirmation + 落回 running，不续跑。
  if (!pending) {
    addEvent('agent.confirmation.missing_pending', {
      span: getActiveSpan(runTraceKey(id, run.runId)),
      attrs: { sessionId: id, runId: run.runId },
    })
    patchRun(id, { status: 'running', pendingToolConfirmation: undefined })
    return
  }
  addEvent('agent.confirmation.decision', {
    span: getActiveSpan(runTraceKey(id, run.runId)),
    attrs: {
      sessionId: id,
      runId: run.runId,
      toolName: pending.toolName,
      callId: pending.callId,
      approved,
      always: Boolean(always),
    },
  })

  const meta = rootStore.getter(sessionsAtom)[id]
  const apiKey = meta?.settings.vendor === 'glm' ? runtimeConfig.glmApiKey : runtimeConfig.deepseekApiKey

  if (!approved) {
    // 拒绝：给该 tool_call 回填 error result（序列合法），落回 running，重入循环让 model 改道。
    appendItem(id, {
      id: newId(),
      createdAt: Date.now(),
      item: { role: 'tool', tool_call_id: pending.callId, content: JSON.stringify({ error: '用户拒绝执行该工具' }) },
    })
    patchRun(id, { status: 'running', pendingToolConfirmation: undefined })
    const signal = beginRun(id)
    void runToolLoop(id, run.runId, { signal, apiKey, fetchImpl: runtimeConfig.fetchImpl }).finally(() =>
      endRun(id, signal),
    )
    return
  }

  // 允许：可选「本 session 一律允许该工具」→ 记瞬态集合；落回 running，重入循环并让其先执行被确认工具。
  if (always) addAlwaysAllowedTool(id, pending.toolName)
  patchRun(id, { status: 'running', pendingToolConfirmation: undefined })
  const signal = beginRun(id)
  void runToolLoop(id, run.runId, {
    signal,
    apiKey,
    fetchImpl: runtimeConfig.fetchImpl,
    resumeToolCall: { callId: pending.callId, toolName: pending.toolName, args: pending.args },
  }).finally(() => endRun(id, signal))
}

// ===========================================================================
// 卡片交互命令（P8-c）—— UI 卡片的答案回填 / 产物丢弃
// ===========================================================================

// 简介：记录当前 active 会话某个 question 的答案（AskUserQuestionCard onChange 调用）。
// 详情：取 activeId，无 active → no-op。写入走 transientAtoms 的 setter（内部已带 ghost guard）。
export function answerQuestion(questionId: string, value: AskUserAnswerValue): void {
  const id = rootStore.getter(activeSessionIdAtom)
  if (!id) return
  setPendingQuestionAnswer(id, questionId, value)
}

// 简介：从指定会话丢弃一个 save_file 待保存产物（SaveArtifact 保存成功后调用）。
// 详情：收显式 sessionId（PF4）—— 卡片点击时捕获归属会话，异步保存期间 active 可能被切走，
//   故不取 active，只删传入 sessionId 的产物（removePendingArtifact 内部带 ghost guard）。
export function discardArtifact(sessionId: string, artifactId: string): void {
  removePendingArtifact(sessionId, artifactId)
}

// ===========================================================================
// 回退命令
// ===========================================================================

// 简介：对当前 active 会话回退到第 turnIndex 轮（截断式回退）。
export function revertToTurn(turnIndex: number): void {
  const id = rootStore.getter(activeSessionIdAtom)
  if (!id) return
  // 先校验 turnIndex 合法（越界/负数 → 整体 no-op）。否则 jumpToCheckpoint 内存里 no-op、但
  // persistTruncate(id, -1) 会走 truncateAfter(id, -1) 把盘上「全部」checkpoint 删光，刷新丢历史
  // （codex P2）。校验读该会话 store 的 checkpointsAtom；幽灵会话取到 [] → 任何 index 都越界 → no-op。
  const checkpoints = getSessionStore(id).store.getter(checkpointsAtom)
  if (turnIndex < 0 || turnIndex >= checkpoints.length) return
  // 回退前先停当前 run —— 否则回退改了 items/checkpoints，正在跑的 run 完成时又
  // appendItem/commitCheckpoint 会污染回退后的状态（与 removeSession 的破坏性命令前先 abort 一致）。
  abortRun(id)
  jumpToCheckpoint(id, turnIndex)
  // 剪掉「被丢弃轮次」产生的 browser 卡片（codex P2）：browserCards 不进 checkpoint 快照，
  //   jumpToCheckpoint 只截断 items，需按回退点 checkpoint 的 createdAt 把之后的卡片一并剪掉，
  //   否则回退后仍渲染已废弃轮的卡片。
  pruneBrowserCardsAfter(id, checkpoints[turnIndex].createdAt)
  pruneRuntimeTranscriptEventsAfter(id, checkpoints[turnIndex].createdAt)
  persistTruncate(id, turnIndex) // D-4：截断式回退 → 同步截断持久化 checkpoint（fire-and-forget）。
}
