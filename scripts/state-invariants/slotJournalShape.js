// ---------------------------------------------------------------------------
// 规则 3 · 进事务日志的值不许随累积状态长大
// ---------------------------------------------------------------------------
// 为什么：整值记账（`writeSlot` 存 before/after 两份完整槽位值）对随对话增长的槽位是**二次**开销
//   `cap × 累积长度`。内存里看不出来（新旧数组共享条目引用），JSON / structuredClone 不认共享引用，
//   于是账单只在**落盘那一步**兑现：实测 `items` 一份 0.32 MB 的对话要写 33 MB。
// 违反后：不报错。会话越长写得越慢、盘越涨，直到某次落盘把主线程卡住才被发现。
//
// 判据**不是**「这个槽位看起来像不像数组」—— 那种启发式在下一个 Map/Record 型累积槽位上会失灵，
// 而失灵的方向恰好是漏报。改成**穷举分类**：SESSION_SLOTS 的每个 key 必须恰好落在下面三张表之一，
// 新增槽位不分类即 error。这样「新增了一个大槽位却没人想过它的记账形态」不可能悄悄溜过去。

import { SLOTS_FILE, slotDeclarations } from './slotSource.js'

// 走增量 op 的槽位：热路径写入落成 append/patch/remove，ops 载荷与累积长度无关。
// **登记在这张表里不算数** —— 脚本会回到 sessionSlots.ts 源码确认那次 `slot(...)` 真的传了第 4 个
// 参数（增量 applier registrar）。表说走增量、源码没走，正是最容易发生且最没人发现的漂移。
const deltaJournaledSlots = [
  'items',
  'pendingArtifacts',
  'executionGraph',
  'planStageCheckpoints',
  'subagentContinuations',
]
// 整值记账的槽位。每一项必须写明**凭什么不会随累积状态长大** —— 说不出理由就是没想过，
// 而没想过的那个终将是下一个 33 MB。
const boundedWholeValueSlots = [
  {
    key: 'run',
    reason: '单个 RunState，字段集固定；pendingToolCalls / loadedTools / toolCallOutcomes 只在一次 run '
      + '内部长，run 结束或新 run 开始即整体替换，不跨轮累积',
  },
  {
    key: 'plan',
    reason: 'stages 数在建计划时定死，改计划是整体替换（revision+1）而非追加，不随对话增长',
  },
  {
    key: 'pendingQuestionAnswers',
    reason: '只装当前挂起的那一次 ask_user_question 的作答，消费即清空，条目数等于该次提问的问题数',
  },
  {
    key: 'queuedUserMessages',
    reason: '运行期间排队的用户输入，出队即消费；上界是用户手速而不是会话长度',
  },
  {
    key: 'contextCheckpoint',
    // 这一条**不是有界的**，如实写成「量级不构成二次开销」而不是「有界」：照着抄一个假理由，
    // 下一个人就会拿它给真正的累积槽位背书。
    reason: 'summary 与 coveredItemIds 随对话长，严格说不有界；但它只在压缩发生时写，一个会话几次，'
      + '粗估合计几百 KB 级，不构成二次开销。压缩若变成高频写，这一项就必须改走增量 op',
  },
]
// 进快照、但**不入账**的槽位：它不产生日志载荷，所以不受本规则约束，但仍要显式分类，
// 免得「没入账」和「忘了分类」看起来一模一样。
const snapshotOnlySlots = [
  {
    key: 'composerDraft',
    reason: '逐击键写入，记账会让敲一百个字就填满 undo 的 cap、把真实轮次账目挤出去；'
      + '判据与「为什么不做只在清空时记账的折中」见 state/sessionTransientMutations.ts 的 setComposerDraft',
  },
]

/**
 * 规则 3 的判定：槽位表与三张分类表必须逐项对齐，且 `deltaJournaled` 的每一项在源码里确有 registrar。
 *
 * 四种失配都是 error 而不是观察项：它们各自对应一种「漏了不报错、落盘那一步才兑现」的开销，
 * 降级成观察项等于允许它长期挂着。
 */
async function checkJournalPayloadShape({ repositoryRoot, errors }) {
  const declarations = await slotDeclarations(repositoryRoot)
  const declared = new Map(declarations.map((item) => [item.key, item]))
  const classifications = [
    ...deltaJournaledSlots.map((key) => ({ key, table: 'deltaJournaled' })),
    ...boundedWholeValueSlots.map((item) => ({ ...item, table: 'boundedWholeValue' })),
    ...snapshotOnlySlots.map((item) => ({ ...item, table: 'snapshotOnly' })),
  ]

  const seen = new Map()
  for (const { key, table } of classifications) {
    const previous = seen.get(key)
    if (previous) {
      errors.push(`槽位 ${key} 同时登记在 ${previous} 与 ${table} —— 一个槽位只能有一种记账形态`)
      continue
    }
    seen.set(key, table)
    if (!declared.has(key)) {
      errors.push(
        `state-invariants/slotJournalShape.js 的 ${table} 里有 ${key}，但 ${SLOTS_FILE} 已无此槽位`
        + ' —— 陈旧条目会让分类表和源码悄悄漂移，请删掉它',
      )
    }
  }

  for (const { key, line, argumentCount } of declarations) {
    const table = seen.get(key)
    if (!table) {
      errors.push(
        `${SLOTS_FILE}:${line} 槽位 ${key} 未分类 —— 新增槽位必须在 state-invariants/slotJournalShape.js 的`
        + ' deltaJournaled / boundedWholeValue / snapshotOnly 之一里登记，'
        + '整值记账一个随对话增长的槽位是二次开销，且只在落盘那一步兑现',
      )
      continue
    }
    if (table === 'deltaJournaled' && argumentCount < 4) {
      errors.push(
        `${SLOTS_FILE}:${line} 槽位 ${key} 登记为走增量 op，但 slot(...) 没传第 4 个参数（增量 applier`
        + ' registrar）—— 表说走增量、实际仍是整值记账，是本规则唯一会静默复发的漂移',
      )
    }
  }
}

export const slotJournalShapeRule = {
  summary: [
    `规则 3：SESSION_SLOTS 的每个槽位都已分类（增量 ${deltaJournaledSlots.length} / `
    + `有界整值 ${boundedWholeValueSlots.length} / 只进快照 ${snapshotOnlySlots.length}），`
    + '且登记为增量的都在源码里带了 registrar——整值记账累积槽位是二次开销，只在落盘时兑现。',
  ],
  run: checkJournalPayloadShape,
}
