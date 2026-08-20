// 自我反思机制的提示文案单一来源 —— 叶子模块，零 import、零副作用。
// ---------------------------------------------------------------------------
// 这两条机制的文案原本各自内联在使用点，改动时没有任何东西能证明「eval 里测的那句」和
// 「线上真正发出去的那句」是同一串字节。集中到本文件后：
//   · SELF_CHECK_CLAUSES —— buildSystemItem（modelTurnSystemItems.ts）固定 system 的静态条款；
//     协议条款整段移除后，这两条就是那条 system 的全部内容；
//   · toolFailureStreakNotice —— modelRun.ts 工具失败软提醒的一次性注入文案；
//   · TOOL_FAILURE_STREAK_THRESHOLD / TOOL_FAILURE_ERROR_PREVIEW_LIMIT —— 触发阈值与错误摘要长度。
// evals 目录下的 prompt 行为 A/B 套件直接 import 这里，保证测的就是线上文案。
//
// ★ 为什么单开一个叶子文件，而不是从 modelTurn / modelRun 导出 ★
//   · modelTurn.ts 会经装配的 skill registry 拉进 .md?raw 模块声明 —— evals 的独立 tsconfig
//     （types 只有 node + vitest/globals，没有 vite/client）解析不了，直接 TS2307；它还会经
//     tools/registry.ts 触发 defaultCore 实例化，只为读一句提示文案不该有这种副作用。
//   · modelRun.ts 更重：宿主命令桥、持久化桥和全部 state atoms 都在它的模块图里。
//   本文件不 import 任何东西，所以谁 import 它都不成环，也不会拖进上述任何一样。

/**
 * 固定运行时 system 的收尾自查 / 如实报告条款（协议条款移除后，即 buildSystemItem 的全部内容）。
 * 顺序与字节都是契约：改这里等于改线上 prompt。
 */
export const SELF_CHECK_CLAUSES: readonly string[] = [
  '收尾自查：结束回合前检查你最后一段话；若它是计划、待办清单或"接下来我会…"式的承诺，说明任务尚未完成——继续调用工具把它做完，或如实说明停下的原因；不得在未执行的情况下描述将要做的事然后结束回合。',
  '如实报告：命令失败、测试未通过或步骤被跳过时，必须原样说明并附关键错误信息；不得声称已完成，不得淡化问题。',
]

// 工具失败软提醒：同一工具在本次 run 内失败次数达到该阈值后，下一轮临时注入一条 system 提醒。
// 阈值 1 = 每次失败落地即提醒一次（一次性消费）；streak 计数仍按连续失败累计，供文案区分单次/多次。
// 只提醒、不熔断 —— 终止职责在 loopGuard / max_turns，这里永远不改 run 状态。
// ★ 为什么是 1 而不是 2 ★ —— 首轮行为 A/B 实测（results/2026-07-27T04-30-44.647Z.behavior-ab.jsonl）：
//   评测里主力模型的主导失败模式是「两败即弃」（8/10 run 在第 3 次调用前放弃），不是「原样重试」
//   （10 run 仅 1 例）。阈值 2 的提醒到达时机与放弃时机重合，5 次注入 0 转化，故提前到第一次失败。
export const TOOL_FAILURE_STREAK_THRESHOLD = 1
// 提醒里回带的「最近一次错误」摘要长度：够模型认出失败原因，又不至于把长错误再灌满上下文。
export const TOOL_FAILURE_ERROR_PREVIEW_LIMIT = 200

// 工具连败软提醒的 per-run 计数（同一工具连续失败次数 + 最近一次错误摘要）。
export interface ToolFailureStreak {
  count: number
  lastError: string
}

// 工具失败软提醒文案：把「哪个工具、败了几次、最近错什么」摊给模型，并把重心压在「先按错误提示自救」。
// 这条提醒只进请求投影（与计划续跑提醒同构），不写 itemsAtom、不落 checkpoint、也不终止 run。
// ★ 文案重心 ★ —— 实测里模型的默认动作是「两败即弃」而非原样重试，所以指令句先给出路（错误信息里
//   通常已写明可用参数 / 替代工具 / 前置条件），把「停下来说明阻塞」压到最后并加「仅当…」限定，
//   不给放弃递台阶。
export function toolFailureStreakNotice(
  streaks: Array<readonly [string, ToolFailureStreak]>,
): string {
  return [
    '以下工具调用失败：',
    ...streaks.map(([name, streak]) =>
      streak.count === 1
        ? `· ${name}：调用失败；错误：${streak.lastError}`
        : `· ${name}：已连续失败 ${streak.count} 次；最近一次错误：${streak.lastError}`),
    '错误信息里往往已经给出可行的出路（可用的参数、替代工具或前置条件）；请先按提示调整参数或换用其它工具/方法再试，不要原样重发同一调用。仅当确认没有任何可尝试的调整时，才停下并如实向用户说明阻塞原因。',
  ].join('\n')
}
