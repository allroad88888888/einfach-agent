// 当前工作区根目录：有本机宿主桥时可以调用系统文件夹选择器，否则保持手动路径输入。
import { useState } from 'react'
import { useRootAtomValue } from '@einfach-agent/react-plugin'
import {
  activeWorkspaceMetaAtom,
  canPickWorkspaceDirectory,
  pickWorkspaceDirectory,
  setWorkspaceRoot,
} from '@einfach-agent/core'
import { Trans, useLingui } from '@lingui/react/macro'

export function WorkspaceRootField() {
  const { t } = useLingui()
  const workspace = useRootAtomValue(activeWorkspaceMetaAtom)
  const [pickerState, setPickerState] = useState<{ picking: boolean; error?: string }>({ picking: false })
  const canPick = canPickWorkspaceDirectory()
  if (!workspace) return null

  async function chooseDirectory(): Promise<void> {
    if (pickerState.picking) return
    setPickerState({ picking: true })
    const result = await pickWorkspaceDirectory()
    if (!result.ok) {
      setPickerState({ picking: false, error: result.error })
      return
    }
    setPickerState({ picking: false })
    if (result.path) setWorkspaceRoot(result.path)
  }

  return (
    <div className="agentnew-workspace-root">
      <label className="agentnew-workspace-root-label" htmlFor="agentnew-workspace-root-input">
        <Trans>工作区目录</Trans>
      </label>
      <div className="agentnew-workspace-root-row">
        <input
          id="agentnew-workspace-root-input"
          className="agentnew-workspace-root-input"
          type="text"
          placeholder={t`工作区绝对路径（留空则用 Git 根目录）`}
          value={workspace.rootPath ?? ''}
          onChange={(event) => {
            setPickerState({ picking: false })
            setWorkspaceRoot(event.target.value)
          }}
        />
        {canPick ? (
          <button
            type="button"
            className="agentnew-workspace-root-button"
            disabled={pickerState.picking}
            onClick={() => { void chooseDirectory() }}
          >
            {pickerState.picking ? <Trans>正在打开…</Trans> : <Trans>选择文件夹</Trans>}
          </button>
        ) : null}
      </div>
      {pickerState.error ? <p className="agentnew-workspace-root-error" role="alert">{pickerState.error}</p> : null}
    </div>
  )
}
