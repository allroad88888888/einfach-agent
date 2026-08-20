// 下线模型名迁移插件（Core 抽离 Stage 2a）—— 把 modelRun.ts 内联的 migrateSessionMeta 搬成
// onRunStart 插件，并升级为【store 归一化】：让 sessionsAtom 成为「有效 settings」的唯一真相源。
// ---------------------------------------------------------------------------
// 契约：docs/core-plugin-extraction-blueprint.md §五（「模型名迁移 → migrationPlugin」那一行）+
//   本轮已拍板的架构决定（store 归一化）。形状照当年的上下文压缩插件（已随 A1 删除）：逻辑本体
//   抽成可独立单测的具名函数 applyMigration，插件只把它接进 onRunStart 槽。
//
// 【最高铁律】纯结构搬迁，行为零变化。危险工具确认 / ask_user 暂停两条挂起/恢复流【一行未动】，
//   仍是 toolCallBatch.ts 里硬编码的风险判定 + 暂停流程（loop 的工具批次处理一环），没有走这套
//   插件 hook，留 Stage 2b。
//
// ── 背景：Stage 1 review 抓到的「分叉」 ──
//   modelRun.ts 在 runToolLoop 顶部（ghost 守卫后）做 `const meta = migrateSessionMeta(rawMeta)`，
//   产出一个【本地】迁移后 meta 但【不写回 store】。于是同一轮里读 store 的插件（如压缩插件）只能
//   看到【未迁移】的 settings，被迫各自再 migrateModelSettings 一次（当年的上下文压缩插件也有
//   这个「双迁」问题），
//   两侧靠「两个纯函数调同一份规则」勉强收敛——今天两条迁移都 1M→1M 掩盖了漂移，但未来不同窗口的
//   下线就会真分叉。本插件把迁移【写回 store】：store 从此是迁移后的唯一真相，下游所有读 store 的
//   插件天然拿到迁移后值，双迁可撤（撤除动作由集成 agent 做，见文件尾说明）。
//
// ── 行为对齐现状（写于本插件落地那一刻，「现在」指落地前的 modelRun 请求路径）──
//   落地前 modelRun 的「请求路径兜底」就是 migrateSessionMeta；本插件把它从「本地变量」升级成
//   「写回 store」，语义等价 + 消除分叉，原来那处内联 fallback 随之删除——今天 runtime/ 下只剩
//   本文件和 state/persistence/hydrate.ts（加载时的另一条迁移路径）还在调 migrateSessionMeta。
//   迁移规则（幂等 / 不误伤未知模型 / 不覆盖用户显式 thinking）全部原样继承 migrateSessionMeta，
//   本文件一条规则都不重写。

import { sessionsAtom } from '../../../state/rootStore'
import { migrateSessionMeta } from '../../../state/persistence/modelMigration'
import type { CoreCtx } from '../coreCtx'
import type { AgentPlugin } from '../pluginApi'

// 简介：迁移逻辑本体——onRunStart 时把迁移后的 SessionMeta 归一化写进内存 sessionsAtom。
// 详情：读 ctx.root 的会话 meta，用 migrateSessionMeta 算迁移后值；仅当【真的发生迁移】
//   （migrateSessionMeta 返回不同引用）才写回 store。三条守卫顺序：
//     1) 会话已被 drop（ghost）→ 无 meta 可迁，no-op（也避免把 undefined 喂进 migrateSessionMeta——
//        它会读 .settings 崩）。正常路径 loop 的 ghost 守卫已挡在前面，这里再兜一层。
//     2) migrated === current（幂等 / 未知模型名 / 已是新名）→ 不写。store 已是迁移后，重复写只会
//        平白产生新引用、触发无谓订阅。这一步保证「连调两次结果一致，且第二次不写」。
//     3) PX4 写前自查 ctx.isCurrent()：onRunStart 虽在 run 早期（ghost/stale 守卫刚过），仍按纪律
//        自查——被新 run 顶掉的旧 run、或已消失的会话，都不得再往 sessionsAtom 塞值污染新 run / 幽灵会话。
//   写回只碰内存 sessionsAtom，【绝不落盘】（round-6 决定：磁盘留原值，兼容层每次启动照迁即可）；
//   updatedAt 不动 —— 兼容迁移不是「用户改了会话」，改它会顶掉 hydrate 选 active 会话的排序依据
//   （migrateSessionMeta 本身也刻意只碰 settings，这里的写回沿用它产出的整份 meta，故 updatedAt 天然不变）。
export function applyMigration(ctx: CoreCtx): void {
  const current = ctx.root.getter(sessionsAtom)[ctx.sessionId]
  // 守卫 1：会话不存在（ghost）——无可迁，静默返回，不抛。
  if (!current) return
  // migrateSessionMeta 的不变量：无需迁移时【原样返回同一引用】，据此廉价判断「这轮到底改没改」。
  const migrated = migrateSessionMeta(current)
  // 守卫 2：同一引用（幂等 / 未知模型名 / 已迁）——不写。
  if (migrated === current) return
  // 守卫 3：PX4 写前自查——被顶掉 / 幽灵会话不得写。
  if (!ctx.isCurrent()) return
  // 归一化：只写内存 sessionsAtom（函数式更新，读 prev 保留其它会话），不落盘、updatedAt 不动。
  ctx.root.setter(sessionsAtom, (prev) => ({ ...prev, [ctx.sessionId]: migrated }))
}

// 简介：下线模型名迁移插件（PX2 AgentPlugin）——装配期把 applyMigration 注册进 onRunStart 槽。
// 详情：onRunStart「run 开始、第一轮请求之前调一次」正是把 sessionsAtom 归一化成「有效 settings
//   唯一真相源」的时机；此后同一 run 里所有读 store 的插件（压缩等）天然拿到迁移后值。
export const migrationPlugin: AgentPlugin = (api) => {
  api.hook('onRunStart', (ctx) => {
    applyMigration(ctx)
  })
}
