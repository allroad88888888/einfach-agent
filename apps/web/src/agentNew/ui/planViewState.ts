// 计划相关面板的展开/折叠偏好。
// ---------------------------------------------------------------------------
// 纯渲染态：住 UI store，只由 PlanPanel / CompletedPlanRecord 读写，不含任何用户或模型产出的
// 内容，刷新回默认视图。这三个 atom 曾经住在 core 的 sessionTransientAtoms.ts 里，于是每一个
// 都得在门禁的归宿表里占一条「不含任何内容」的登记——搬出来之后那种登记就不必存在了。

import { atom } from '@einfach/core'

/** 计划阶段详情的显式展开选择（stage id → 是否展开）。 */
export const expandedPlanStagesAtom = atom<Record<string, boolean>>({})

/** 计划面板整体是否展开。 */
export const planPanelExpandedAtom = atom(true)

/** 已完成计划记录是否展开；记录随消息列表滚动，不占用执行操作区。 */
export const completedPlanRecordExpandedAtom = atom(false)
