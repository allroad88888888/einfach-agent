// S4-A WorkspaceRootField：在当前工作区的设置弹层中编辑根目录。
// ---------------------------------------------------------------------------
// 契约 U1 —— 只读 atom（rootStore 的 activeSessionMetaAtom）+ 调命令（setWorkspaceRoot）；
//   绝不直接 setter atom / import writers / 碰 store 实例。挂在侧边栏（与 SessionList 同在根 Provider
//   下），故能读到 rootStore 的工作区元信息。无 active 工作区时不渲染。
import { useMemo } from 'react'
import { atom } from '@einfach/core'
import { useAtom } from '@einfach/react'
import { useRootAtomValue } from '@web-agent/react-plugin'
import {
  activeWorkspaceMetaAtom,
  canPickWorkspaceDirectory,
  pickWorkspaceDirectory,
  setWorkspaceRoot,
} from '@web-agent/core'

const workspacePickerStateAtom = atom<{ isPicking: boolean; error: string | null }>({
  isPicking: false,
  error: null,
})

export function WorkspaceRootField() {
  const workspace = useRootAtomValue(activeWorkspaceMetaAtom)
  const [pickerState, setPickerState] = useAtom(workspacePickerStateAtom)
  const canPick = useMemo(() => canPickWorkspaceDirectory(), [])
  if (!workspace) return null

  async function handlePickDirectory(): Promise<void> {
    if (pickerState.isPicking) return
    setPickerState({ isPicking: true, error: null })
    const result = await pickWorkspaceDirectory(workspace?.rootPath)
    if (!result.ok) {
      setPickerState({ isPicking: false, error: result.error })
      return
    }
    setPickerState({ isPicking: false, error: null })
    if (result.path) {
      setWorkspaceRoot(result.path)
    }
  }

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
            setPickerState({ isPicking: false, error: null })
            setWorkspaceRoot(event.target.value)
          }}
        />
        <button
          className="agentnew-workspace-root-button"
          type="button"
          disabled={!canPick || pickerState.isPicking}
          title={canPick ? '选择工作区' : '仅 Tauri 桌面可用'}
          onClick={() => {
            void handlePickDirectory()
          }}
        >
          {pickerState.isPicking ? '选择中' : '选择'}
        </button>
      </div>
      {pickerState.error
        ? <div className="agentnew-workspace-root-error">{pickerState.error}</div>
        : null}
    </div>
  )
}
