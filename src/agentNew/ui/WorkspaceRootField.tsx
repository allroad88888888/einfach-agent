// S4-A WorkspaceRootField：给当前会话绑定 workspace 根目录（左栏，根 rootStore Provider 下）。
// ---------------------------------------------------------------------------
// 契约 U1 —— 只读 atom（rootStore 的 activeSessionMetaAtom）+ 调命令（setWorkspaceRoot）；
//   绝不直接 setter atom / import writers / 碰 store 实例。挂在侧边栏（与 SessionList 同在根 Provider
//   下），故能读到 rootStore 的会话元信息。无 active 会话时不渲染。
import { useMemo, useState } from 'react'
import { useAtomValue } from '@einfach/react'
import { activeSessionMetaAtom } from '../state/rootStore'
import { setWorkspaceRoot } from '../runtime/commands'
import { canPickWorkspaceDirectory, pickWorkspaceDirectory } from '../runtime/workspaceDialog'

export function WorkspaceRootField() {
  const meta = useAtomValue(activeSessionMetaAtom)
  const [isPicking, setIsPicking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const canPick = useMemo(() => canPickWorkspaceDirectory(), [])
  if (!meta) return null

  async function handlePickDirectory(): Promise<void> {
    if (isPicking) return
    setIsPicking(true)
    setError(null)
    const result = await pickWorkspaceDirectory(meta?.workspaceRoot)
    setIsPicking(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    if (result.path) {
      setWorkspaceRoot(result.path)
    }
  }

  return (
    <div className="agentnew-workspace-root">
      <label className="agentnew-workspace-root-label" htmlFor="agentnew-workspace-root-input">
        工作目录
      </label>
      <div className="agentnew-workspace-root-row">
        <input
          id="agentnew-workspace-root-input"
          className="agentnew-workspace-root-input"
          type="text"
          placeholder="workspace 绝对路径（留空则用 git 根目录）"
          value={meta.workspaceRoot ?? ''}
          onChange={(event) => {
            setError(null)
            setWorkspaceRoot(event.target.value)
          }}
        />
        <button
          className="agentnew-workspace-root-button"
          type="button"
          disabled={!canPick || isPicking}
          title={canPick ? '选择工作目录' : '仅 Tauri 桌面可用'}
          onClick={() => {
            void handlePickDirectory()
          }}
        >
          {isPicking ? '选择中' : '选择'}
        </button>
      </div>
      {error ? <div className="agentnew-workspace-root-error">{error}</div> : null}
    </div>
  )
}
