// 工具失败软提醒的提示文案单一来源：运行时与行为评测共用。
// 保持零依赖，供 eval 独立导入，避免加载完整运行时及其宿主装配。

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
