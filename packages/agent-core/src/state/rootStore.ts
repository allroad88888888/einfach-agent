// 顶层「会话列表」store —— 全局唯一，只管跨会话的东西（会话元信息 + 当前会话 id）。
// ---------------------------------------------------------------------------
// 状态边界：store 架构是「每会话一个独立 store + 顶层 rootStore」。
//   · 顶层 rootStore（本文）：全局唯一，只存会话列表 sessionsAtom + 当前会话 activeSessionIdAtom。
//   · 会话内容（items / run / checkpoints）：不在这里，由每会话自己的 store 持有（见 P3/P4）。
// 所以本文严禁出现任何 Record<sessionId, _> 的会话内容分桶，也严禁导出全局 agentStore 单例。
//
// 【实例化 · 第 1 期】本文件改成 defaultCore 的【视图】：
//   · rootStore 不再本地 createStore()，而是 = defaultCore.rootStore；
//   · sessionsAtom / activeSessionIdAtom / activeSessionMetaAtom 的【定义】沉到了 state/rootAtoms.ts
//     （破环：coreInstance 需要根 store，本文件要取 defaultCore，若 atom 还定义在这里且被 coreInstance
//     引用就成环）。这里原样 re-export 它们，故 `import { sessionsAtom } from './rootStore'` 照旧有效。

import type { Store } from '@einfach/core'
import { defaultCore } from '../runtime/core/coreInstance'
import {
  workspacesAtom,
  activeWorkspaceIdAtom,
  expandedWorkspaceIdsAtom,
  workspaceSettingsOpenIdsAtom,
  workspaceRenameStateAtom,
  activeWorkspaceMetaAtom,
  activeWorkspaceRootAtom,
  projectSkillsAtom,
  sessionsAtom,
  activeSessionIdAtom,
  activeSessionMetaAtom,
} from './rootAtoms'

// 简介：全局唯一顶层 store（= 默认实例的根 store）。
// 详情：只承载「跨会话」的状态（会话列表 + 当前会话 id）。会话内容各归各的会话 store。
export const rootStore: Store = defaultCore.rootStore

// 会话列表 atom 现由 rootAtoms.ts 定义，这里 re-export 保持既有 import 路径不变。
export {
  workspacesAtom,
  activeWorkspaceIdAtom,
  expandedWorkspaceIdsAtom,
  workspaceSettingsOpenIdsAtom,
  workspaceRenameStateAtom,
  activeWorkspaceMetaAtom,
  activeWorkspaceRootAtom,
  projectSkillsAtom,
  sessionsAtom,
  activeSessionIdAtom,
  activeSessionMetaAtom,
}

// 简介：复位顶层 store（仅测试用）。
// 详情：把会话列表清空、当前会话 id 置空串，让默认实例的 rootStore 在用例间互不污染。
export function resetRootStore(): void {
  rootStore.setter(workspacesAtom, {})
  rootStore.setter(activeWorkspaceIdAtom, '')
  rootStore.setter(expandedWorkspaceIdsAtom, {})
  rootStore.setter(workspaceSettingsOpenIdsAtom, {})
  rootStore.setter(workspaceRenameStateAtom, null)
  rootStore.setter(sessionsAtom, {})
  rootStore.setter(activeSessionIdAtom, '')
}
