// 会话 atom 的归宿登记表 —— 规则 4 判定用的那张表本身。
// ---------------------------------------------------------------------------
// 单独成文件而不是塞在 atomDisposition.js 里：那边是**判定**（表与源码对不对得上），
// 这边是**账**（每个 atom 归在哪一类、凭什么）。两者的读者不同——改 atom 的人只需要读这张表，
// 改门禁的人才需要读判定；而且理由是要长期加下去的，绑在一起迟早顶破行数上限。
//
// 判据与「为什么还多一类 knownLoss」写在 atomDisposition.js 的文件头，不在这里重复。

/** atom 归宿的全集。外部会话 atom 表的 disposition 也只能取这几个值。 */
export const DISPOSITIONS = ['slot', 'derived', 'recomputable', 'compensated', 'safeDefault', 'knownLoss']

// (1) slot —— 进 SESSION_SLOTS，快照与事务日志都管它。理由不写在这里，写在 sessionSlots.ts。
// **双向校验**：这张表说是槽位的、槽位表里必须真有；槽位表里有的、这张表也必须列成 slot。
// 单向就只挡得住一半：把某个槽位在这里改登记成 `recomputable`，等于宣称它丢了也没关系，
// 而它照旧在快照里 —— 表和源码从此各说各话。
export const slotAtoms = [
  'itemsAtom',
  'contextCheckpointAtom',
  'runAtom',
  'planAtom',
  'planStageCheckpointsAtom',
  'queuedUserMessagesAtom',
  'pendingQuestionAnswersAtom',
  'pendingArtifactsAtom',
  'composerDraftAtom',
  'executionGraphAtom',
  'subagentContinuationsAtom',
]

// (2) derived —— 真相在上游，自己没有写入面，所以无所谓丢不丢。
// 脚本会回源码确认它确实是 `atom((get) => …)`：把一个 primitive atom 登记成 derived 是最省事的
// 蒙混方式，而 primitive 有写入面，丢了就是真丢。反向同样判——derived 不该占一个内容归宿的名额。
export const derivedAtoms = [
  'readyExecutionNodeIdsAtom',
  'activeExecutionNodeIdsAtom',
]

// (3) recomputable —— 能从别处算回来。
export const recomputableAtoms = [
  {
    atom: 'toolActivityAtom',
    reason: '装的不是任何人产出的内容，是入参的格式化结果：全部 ctx.progress 调用要么传常量、要么传 '
      + 'runtime/toolContext/progressReporting.ts 的 shellProgressText / pathProgressText / taskProgressText，'
      + '而入参本身在 items 的 tool_call 里；且 runtime/toolCallExecutor.ts 的 finally 无条件 '
      + 'removeToolActivity，活不过一次调用',
  },
  {
    atom: 'contextStatsAtom',
    reason: '每次模型请求都由 runtime/modelTurnRequester.ts 的 setContextStats 重算一遍'
      + '（发请求前估算、拿到 usage 后覆盖）；红线 10 点名的样板',
  },
  {
    atom: 'runtimeTranscriptEventsAtom',
    reason: '内容是每次请求的 stable prefix / tool manifest 的调试镜像'
      + '（runtime/transcriptInjection.ts 的 injectStablePrefixTranscript）；它与 '
      + 'transcriptInjectionFingerprints 同为瞬态，重启后指纹为空，下一次请求必然把整套重注一遍',
  },
  {
    atom: 'assistantStreamAtom',
    reason: '正文在 items 里有第二份：runtime/assistantStreamWriter.ts 的 flush 先 appendItem 再 '
      + 'setAssistantStream，两边是同一个 ConversationItem；本 atom 只是「哪条正在流」的指针，'
      + '而恢复后该 run 一律转 interrupted，指针本就该空',
  },
]

// (4) compensated —— 有明确的补偿设计。
export const compensatedAtoms = [
  {
    atom: 'browserCardsAtom',
    reason: '补偿实现在**工具返回值**上而不在 core：tools/interaction/src/browser-action/'
      + 'browser-action.ts 的成功分支回 note「卡片不持久化，请在最终回复里文字概括其内容」，'
      + '那句话进 transcript，模型据此把正文复述进 items。删掉那个 note，本条归宿当场失效',
  },
  {
    atom: 'undoBarrierTxIdAtom',
    reason: '它其实持久化了，只是刻意不走恢复快照：随撤销日志整份落盘'
      + '（state/persistence/historyLogDriver.ts 的 PersistedHistoryLog.barrierTxId），'
      + 'hydrate 由 state/persistence/hydrate.ts 的 restoreUndoBarrier 写回。屏障与它保护的那本账'
      + '必须同生同死，分开存会出现「账在、屏障没了」',
  },
]

// (5) safeDefault —— 刷新即恢复安全默认。
export const safeDefaultAtoms = [
  {
    atom: 'withdrawnTurnNoticeAtom',
    // 这条一开始被登记成 recomputable，理由里却自陈「sideEffects 事后无从重算」——标签与理由互相
    // 矛盾。归错类不会报错，但下一个人会拿「连它都算 recomputable」去给真正算不回来的东西背书。
    reason: '唯一生产者是 runtime/commands/planCommands.ts 的 rollbackPlanStage。它**不是**可重算的：'
      + 'sideEffects 判的是那批被丢弃的 items，而同一条命令紧接着就把它们截断了，事后无从重算。'
      + '它留在槽位表外靠的是**生命周期**——这是一条一次性提示，Composer.tsx 在草稿一改动、'
      + '发送成功、或在输入框里按 Esc 时就清掉它。刷新后不显示，等同于用户随手敲一个字符后的状态，'
      + '而且丢的是一句关于「已经做完的事」的通知，不是内容本身',
  },
  {
    atom: 'alwaysAllowedToolsAtom',
    reason: '危险工具的「一律允许」只在本次会话内有效（runtime/commands/runCommands.ts 的 '
      + 'rememberApproval 分支写入），刷新回空 = 每次重新确认，正是红线 10 点名的安全默认',
  },
  {
    atom: 'transcriptInjectionFingerprintsAtom',
    reason: '注入去重的哈希缓存（runtime/transcriptInjection.ts）。空指纹 = 下一次请求把整套前缀'
      + '重注一遍，injectStablePrefixTranscript 的 doc 注释写明这就是期待行为'
      + '（a fresh UI transcript always gets its first set）',
  },
  {
    atom: 'expandedTranscriptGroupsAtom',
    reason: '「思考过程」分组的展开/折叠偏好，只由 apps/web/src/agentNew/ui/MessageList.tsx 读写；'
      + '不含任何内容，刷新回默认视图',
  },
  {
    atom: 'expandedPlanStagesAtom',
    reason: '计划阶段详情的展开偏好，只由 apps/web/src/agentNew/ui 的 PlanPanel.tsx / '
      + 'CompletedPlanRecord.tsx 读写；不含任何内容',
  },
  {
    atom: 'planPanelExpandedAtom',
    reason: '计划面板整体的展开偏好，只由 apps/web/src/agentNew/ui/PlanPanel.tsx 读写；不含任何内容',
  },
  {
    atom: 'completedPlanRecordExpandedAtom',
    reason: '已完成计划记录的展开偏好，只由 apps/web/src/agentNew/ui/CompletedPlanRecord.tsx 读写；'
      + '不含任何内容',
  },
]

// (6) knownLoss —— 已知缺口、接受丢失。每条必须写明：丢的是什么、为什么现在接受、将来怎么修。
// 四个 core 模块里当前为空；唯一在案的缺口 composerImageAttachment 定义在 apps/web，见下面那张表。
// **空不等于不需要这张表**：它是给「先不修」一个有名字的去处，没有它，缺口只能被塞进前三类。
export const knownLossAtoms = []

/**
 * 外部会话 atom：定义在 core 之外、但写进**会话 store** 的 atom。
 *
 * 这张表必须是**显式**的：它们不在 SESSION_ATOM_FILES 里，规则 4 机械枚举不到，所以「漏登记」
 * 在这一片仍然不会炸——红线 10 因此不能删，只能收窄到这一片。本表只保证在案的条目不陈旧
 * （文件还在、atom 名还在文件里），保不了「有没有第三个没人登记的」。
 */
export const externalSessionAtoms = [
  {
    atom: 'composerImageAttachmentAtom',
    file: 'apps/web/src/agentNew/ui/composerImageAttachmentState.ts',
    disposition: 'knownLoss',
    reason: '装 File 对象、写会话 store（Composer 挂在 ActiveSessionProvider 下），却不进快照，'
      + '而同一个输入框的文字草稿进。丢的只有**粘贴来源**的图（onPaste 直吃 clipboardData.files，'
      + '磁盘上没有第二份；拖拽与选文件的有）。这不是漏登记而是结构性障碍：槽位值要过 '
      + 'state/recoveryProjection.ts 的 jsonClone（JSON round-trip），File 过去会静默变成 {}，'
      + '恢复出一堆 0 字节空附件比不恢复更坏。已裁决接受丢失，将来怎么修见该文件 '
      + 'composerImageAttachmentAtom 的注释',
  },
]