// 顶层「会话列表」atom 的【纯定义】—— 零 runtime 依赖，是破环用的地基层。
// ---------------------------------------------------------------------------
// 背景（实例化 · 第 1 期）：coreInstance 需要 rootStore（=该实例的会话列表 store），
//   而 rootStore.ts 现在要从 defaultCore（来自 coreInstance）取 store —— 若 sessionsAtom /
//   activeSessionIdAtom 仍定义在 rootStore.ts，且 coreInstance 又要引用它们，就成环。
//   解法：把这些 atom 的【定义】沉到本文件（只依赖 @einfach/core 的 atom + 类型），
//   coreInstance / rootStore 都从这里 import；rootStore.ts 再原样 re-export 它们，
//   所以全仓 `import { sessionsAtom } from '../state/rootStore'` 照旧有效，一行不用改。
//
// 状态边界：这里只放「跨会话」的会话列表 + 当前会话 id，
//   严禁出现任何 Record<sessionId, 会话内容> 分桶（那是各会话自己 store 的事）。

import { atom } from '@einfach/core'
import type { SessionMeta, WorkspaceMeta } from './core.type'
import type { ProjectSkillsSnapshot } from '../skills/projectSkills'
import type { DisabledProjectSkillsByWorkspace } from '../skills/projectSkillPreferences'

// 一级工作区登记表。数量通常很小，适合一个浅层 Record atom；会话内容仍按会话独立 store 分桶。
export const workspacesAtom = atom<Record<string, WorkspaceMeta>>({})

// 当前工作区；空串表示尚未创建工作区。
export const activeWorkspaceIdAtom = atom<string>('')

// 展开状态按工作区 id 独立记录，避免把纯 UI 状态混进持久化的 WorkspaceMeta。
export const expandedWorkspaceIdsAtom = atom<Record<string, boolean>>({})

// 每个工作区的设置面板开关；属于瞬态 UI 状态，不随 WorkspaceMeta 持久化。
export const workspaceSettingsOpenIdsAtom = atom<Record<string, boolean>>({})


// 项目 Skills 快照，按 workspaceRoot 分桶（不是按 sessionId —— 同一 workspace 的多个会话共享
// 同一份扫描结果，见 docs/project-skills-blueprint.md「加载时机与缓存」）。这是 workspace 级
// 的跨会话数据，与 workspacesAtom 同类，不违反「禁止会话内容分桶」的边界。
//
// ★ 为什么是 atom 而不是 CoreInstance 里的私有 Map ★ —— 快照有两个消费者：请求组装
//   （modelRun 读它拼清单）和设置面板（展示条目与 diagnostics）。放进 Map 则 UI 无从订阅，
//   点「刷新」后重扫完成也不会重渲染；放进 rootStore 则两者同一事实源，且 core 隔离照旧
//   （每个 CoreInstance 有自己的 rootStore）。
export const projectSkillsAtom = atom<Record<string, ProjectSkillsSnapshot>>({})

// 项目 Skills 的启停偏好按稳定 workspace id 保存；快照仍按 root path 缓存。两者分开后，改路径
// 不会让用户选择泄露到模型请求，也不会把本机偏好写进项目文件。
export const disabledProjectSkillsByWorkspaceAtom = atom<DisabledProjectSkillsByWorkspace>({})

// 当前工作区元信息与工具执行根目录均为纯派生值，不重复存状态。
export const activeWorkspaceMetaAtom = atom(
  (get): WorkspaceMeta | undefined => get(workspacesAtom)[get(activeWorkspaceIdAtom)],
)

export const activeWorkspaceRootAtom = atom(
  (get): string | undefined => get(activeWorkspaceMetaAtom)?.rootPath,
)

// 简介：会话列表元信息（id → SessionMeta）。
// 详情：会话是否存在的权威事实。写入器的 ghost guard 就是查这里有没有登记（见 P5 C7）。
export const sessionsAtom = atom<Record<string, SessionMeta>>({})

// 简介：当前激活的会话 id。
// 详情：空串表示「无激活会话」。UI 切会话 = 改这个 + 切到对应会话 store。
export const activeSessionIdAtom = atom<string>('')

// 简介：当前会话的元信息（派生）。
// 详情：由 sessionsAtom + activeSessionIdAtom 组合得出；activeSessionId 指向未登记会话时为 undefined。
export const activeSessionMetaAtom = atom(
  (get): SessionMeta | undefined => get(sessionsAtom)[get(activeSessionIdAtom)],
)
