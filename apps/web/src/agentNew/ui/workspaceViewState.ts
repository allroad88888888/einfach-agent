// 工作区侧边栏的纯渲染态。
// ---------------------------------------------------------------------------
// 住界面 store。重命名草稿只在「双击标题 → 敲字 → 回车/失焦提交」这一小段里存在，提交走
// renameWorkspace 命令；它既不进快照也没有 core 侧的读者，此前却住在 core 的 rootAtoms.ts 里 ——
// 那是「渲染层随手 useAtom，值落在 core 的 store 上」的老毛病，跟四个 expanded* 同一类。
//
// 注意不要把 expandedWorkspaceIds / workspaceSettingsOpenIds 一起搬过来：前者由持久化
// hydrate 回填（state/persistence/hydrate.ts），后者由 toggleWorkspaceSettings 命令写，
// 它们是 core 的 root 状态，只是长得像 UI 态。

import { atom } from '@einfach/core'

/** 正在重命名的工作区 id 与输入框里的草稿；null = 没有在改名。 */
export const workspaceRenameStateAtom = atom<{ id: string; draft: string } | null>(null)
