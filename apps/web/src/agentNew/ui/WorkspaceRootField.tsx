// S4-A WorkspaceRootField：在当前工作区的设置弹层中编辑根目录。
// ---------------------------------------------------------------------------
// 契约 U1 —— 只读 atom（rootStore 的 activeSessionMetaAtom）+ 调命令（setWorkspaceRoot）；
//   绝不直接 setter atom / import writers / 碰 store 实例。挂在侧边栏（与 SessionList 同在根 Provider
//   下），故能读到 rootStore 的工作区元信息。无 active 工作区时不渲染。
//
// 【T1：为什么只剩一个输入框】这里曾有一枚「选择」按钮，调 core 的 `pickWorkspaceDirectory()` 开原生
// 目录选择框。那个实现只存在于桌面端；桌面端退出后它恒答「当前宿主未提供命令桥」，按钮永久 disabled、
// 旁边的错误行永远渲染不出来——一整块不可达的 UI。手工输入绝对路径是今天唯一能切工作区的路径。
// 浏览器自托管下的目录选择是一件**尚未设计**的事（issue 树未决项 U-1：server 端目录浏览 UI /
// 输入框 + server 侧校验 / 读配置里的 workspace 列表）。真做的时候按那条路重新长出交互，
// 不要复活一个只会答 false 的守卫。
import { useRootAtomValue } from '@einfach-agent/react-plugin'
import { activeWorkspaceMetaAtom, setWorkspaceRoot } from '@einfach-agent/core'

export function WorkspaceRootField() {
  const workspace = useRootAtomValue(activeWorkspaceMetaAtom)
  if (!workspace) return null

  return (
    <div className="agentnew-workspace-root">
      <label className="agentnew-workspace-root-label" htmlFor="agentnew-workspace-root-input">
        工作区目录
      </label>
      <div className="agentnew-workspace-root-row">
        <input
          id="agentnew-workspace-root-input"
          className="agentnew-workspace-root-input"
          type="text"
          placeholder="工作区绝对路径（留空则用 Git 根目录）"
          value={workspace.rootPath ?? ''}
          onChange={(event) => {
            setWorkspaceRoot(event.target.value)
          }}
        />
      </div>
    </div>
  )
}
