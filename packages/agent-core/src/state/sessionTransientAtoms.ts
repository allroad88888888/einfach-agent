import { atom } from '@einfach/core'
import type { ContextStatsSnapshot } from './contextStats'
import type {
  AssistantStreamState,
  AskUserAnswerValue,
  BrowserCard,
  PendingArtifact,
  QueuedUserMessage,
  RuntimeTranscriptEvent,
  ToolActivity,
  TranscriptInjectionFingerprints,
  WithdrawnTurnNotice,
} from './sessionTransientPayloads'

// 每个 atom 都是 session store 内的共享 key；值由各 session store 隔离，绝不按 sessionId 分桶。
//
// **这里只放会话状态**，判据是「刷新后必须还原，或 core 运行时读写」。纯渲染态（展开/折叠、
// 草稿、滚动窗口）住在 apps/web 的 UI store 里，core 不认识它们——那些曾经在本文件里，
// 每一个都得在 `atomDispositionTable.js` 占一条「不含任何内容，刷新回默认视图」的登记，
// 把治理表撑成噪音。边界现在是**物理的**：不在 agent store 里就不归 core 管。

// 当前会话的待保存文件产物。
export const pendingArtifactsAtom = atom<PendingArtifact[]>([])

/**
 * 当前会话的浏览器卡片。
 *
 * **归宿：compensated（有补偿设计）。** 红线 10 和 sessionSlots.ts 的文件头都拿这一条当样板，
 * 但样板的落点长期没人指得出来 —— 补上：唯一的生产者是
 * `tools/interaction/src/browser-action/browser-action.ts`，它不写 atom，只调 `ctx.renderCard`；
 * 成功分支回给模型的工具结果里带着 `note: '卡片不持久化，请在最终回复里文字概括其内容'`。
 * 那句 note 进 transcript，于是模型有义务把卡片正文复述进最终回复 —— 卡片本身丢了，内容还在
 * `items` 里。**补偿在工具的返回值上，不在 core 里**：删掉那个 note，本条归宿当场失效。
 */
export const browserCardsAtom = atom<BrowserCard[]>([])

// 当前会话的 AskUserQuestion 待提交答案（questionId → value）。
export const pendingQuestionAnswersAtom = atom<Record<string, AskUserAnswerValue>>({})

/**
 * 当前会话正在跑的工具进度（按 callId）。
 *
 * **归宿：recomputable（能从别处算回来）。** 它装的不是任何人产出的内容，而是入参的格式化结果：
 * 全部 24 处 `ctx.progress(...)` 调用要么传常量（`'应用文件 patch'`），要么传
 * `runtime/toolContext/progressReporting.ts` 的 `shellProgressText` / `pathProgressText` /
 * `taskProgressText` 对该次调用入参的格式化 —— 而入参本身在 `items` 的 tool_call 里，
 * 工具结果另走 tool result 进 `items`。
 *
 * 它还活不过一次调用：`runtime/toolCallExecutor.ts` 的 `finally` 无条件 `removeToolActivity`。
 * 所以崩溃时留在这里的至多是最后一批在飞调用的提示行，而那次 run 恢复后一律转 interrupted ——
 * 把「正在读取文件…」原样恢复出来是**假的进行中**，比空着更坏。
 */
export const toolActivityAtom = atom<ToolActivity[]>([])

// 当前会话的 runtime transcript 调试事件；不进 checkpoint，也不参与 model messages。
export const runtimeTranscriptEventsAtom = atom<RuntimeTranscriptEvent[]>([])

// 当前会话正在生成的 assistant 消息；runId 用于阻止旧 run 清掉新 run 的流消息。
export const assistantStreamAtom = atom<AssistantStreamState | undefined>(undefined)

// 当前会话注入卡片的去重指纹；只服务 runtime 判重，不进 checkpoint、不持久化。
export const transcriptInjectionFingerprintsAtom = atom<TranscriptInjectionFingerprints>({})

// 当前会话最近一次 LLM 调用的上下文统计；不进 messages、不持久化、不回发给 model。
export const contextStatsAtom = atom<ContextStatsSnapshot | undefined>(undefined)

// 当前会话等待注入正在运行 run 的用户输入（FIFO）。
export const queuedUserMessagesAtom = atom<QueuedUserMessage[]>([])

/**
 * 撤回当前未完成轮后的提示。
 *
 * **归宿：safeDefault（刷新即恢复安全默认）。** 判据是红线 10 的那句「这份内容除了它自己还活在
 * 哪里」——这里根本没有「内容」：唯一的生产者是 `runtime/commands/planCommands.ts` 的
 * `rollbackPlanStage`，`text` 是它就地写死的两句常量，`sideEffects` 是 `currentTurnHasSideEffects(...)`
 * 对被丢弃 items 的一次判定。既非用户原话也非模型产出，因此不适用「唯一副本必须进 allowlist」。
 *
 * **不要把它记成「可重算」**：`sideEffects` 算完之后同一条命令就把那批 items 截断掉了，事后无从
 * 重算——归错类不报错，但下一个人会拿「连它都算可重算」去给真正算不回来的东西背书。
 * 支撑它留在表外的是**生命周期**：这是一条一次性提示，`Composer.tsx` 在草稿一改动（`updateDraft`
 * 挂在 textarea 的 `onChange` 上）、发送成功、或在输入框里按 Esc 时就 `setNotice(undefined)`。
 * 崩溃后不显示，等同于用户随手敲一个字符后的状态；而且丢的是一句关于「已经做完的事」的通知，
 * 不是内容本身——被撤回的对话由 `items` + `planStageCheckpoints` 两个槽位负责，不靠这条提示。
 */
export const withdrawnTurnNoticeAtom = atom<WithdrawnTurnNotice | undefined>(undefined)

// 本 session「一律允许」的危险工具名集合；临时 UI 态，刷新即恢复每次确认的安全默认。
export const alwaysAllowedToolsAtom = atom<string[]>([])

/**
 * 撤销屏障：这条账目及更早的都**不许再撤销**，因为越过它会复活已被不可逆释放掉的内容。
 *
 * 立屏障的时机是「发生了跨进程边界的不可逆动作」—— 当前只有一处：用户显式停止 run 时，
 * `disposeUserContentAfterMutation` 会真的去删 provider 侧的上传。删掉之后再撤销
 * 就会把排队消息恢复成指向已删除上传的坏引用，而删除是收不回来的。
 *
 * 存的是账目的 `txId` 而不是下标：cap 溢出会整体左移下标，而 txId 不会变。屏障那条被 cap
 * 逐出之后，剩下的条目全都比它新，于是撤销全部放行 —— 这正是对的。
 *
 * **刻意不在 SESSION_SLOTS 里**：它不能被撤销，否则撤一步就把自己的守卫撤掉了。它也不进恢复
 * 快照，而是跟着撤销日志一起落盘（`PersistedHistoryLog.barrierTxId`）—— 屏障与它保护的那本账
 * 必须同生同死，分开存就会出现「账在、屏障没了」。
 */
export const undoBarrierTxIdAtom = atom<string | undefined>(undefined)
