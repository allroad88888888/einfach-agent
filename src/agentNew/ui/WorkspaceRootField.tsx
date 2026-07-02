// S4-A WorkspaceRootField：给当前会话绑定 workspace 根目录（左栏，根 rootStore Provider 下）。
// ---------------------------------------------------------------------------
// 契约 U1 —— 只读 atom（rootStore 的 activeSessionMetaAtom）+ 调命令（setWorkspaceRoot）；
//   绝不直接 setter atom / import writers / 碰 store 实例。挂在侧边栏（与 SessionList 同在根 Provider
//   下），故能读到 rootStore 的会话元信息。无 active 会话时不渲染。
// MVP：手填绝对路径。TODO(S4)：接原生文件夹 picker 选目录，替换手填。

import { useAtomValue } from '@einfach/react'
import { activeSessionMetaAtom } from '../state/rootStore'
import { setWorkspaceRoot } from '../runtime/commands'

export function WorkspaceRootField() {
  const meta = useAtomValue(activeSessionMetaAtom)
  if (!meta) return null

  return (
    <div className="agentnew-workspace-root">
      <label className="agentnew-workspace-root-label" htmlFor="agentnew-workspace-root-input">
        工作目录
      </label>
      <input
        id="agentnew-workspace-root-input"
        className="agentnew-workspace-root-input"
        type="text"
        placeholder="workspace 绝对路径（留空则用 git 根目录）"
        value={meta.workspaceRoot ?? ''}
        onChange={(event) => setWorkspaceRoot(event.target.value)}
      />
    </div>
  )
}
