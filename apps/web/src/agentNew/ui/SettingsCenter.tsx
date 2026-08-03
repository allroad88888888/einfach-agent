import { useEffect, useRef } from 'react'
import { useAtomValue } from '@einfach/react'
import {
  closeSettingsCenter,
  hydrateMcpSettings,
  openSettingsCenter,
  selectSettingsTab,
} from '../../mcp/commands'
import { settingsCenterOpenAtom, settingsCenterTabAtom } from '../../mcp/state'
import { hydrateAppSettings, saveCustomInstructions, updateCustomInstructionsDraft } from '../../settings/commands'
import { MAX_CUSTOM_INSTRUCTIONS_LENGTH } from '../../settings/config'
import {
  customInstructionsDirtyAtom,
  customInstructionsDraftAtom,
  customInstructionsStatusAtom,
} from '../../settings/state'
import type { SettingsCenterTab } from '../../mcp/types'
import { McpSettingsPanel } from './McpSettingsPanel'
import { ModelCredentialPanel } from './ModelCredentialPanel'
import { ProjectSkillsPanel } from './ProjectSkillsPanel'

const SETTINGS_TABS: ReadonlyArray<{ id: SettingsCenterTab; label: string }> = [
  { id: 'mcp', label: 'MCP 服务' },
  { id: 'model', label: '模型' },
  { id: 'instructions', label: '自定义指令' },
  { id: 'general', label: '通用' },
  { id: 'skills', label: '项目 Skills' },
]

const SETTINGS_FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function visibleFocusableElements(dialog: HTMLDialogElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(SETTINGS_FOCUSABLE_SELECTOR))
}

function CustomInstructionsPanel() {
  const draft = useAtomValue(customInstructionsDraftAtom)
  const dirty = useAtomValue(customInstructionsDirtyAtom)
  const status = useAtomValue(customInstructionsStatusAtom)
  const loading = status.status === 'idle' || status.status === 'loading'

  return (
    <section
      className="agentnew-settings-panel agentnew-instructions-panel"
      aria-labelledby="agentnew-custom-instructions-title"
    >
      <div className="agentnew-settings-panel-head">
        <div>
          <h3 id="agentnew-custom-instructions-title">自定义指令</h3>
          <p>保存长期偏好，之后每次对话都会自动提供给 Agent。</p>
        </div>
      </div>

      <label className="agentnew-instructions-field" htmlFor="agentnew-custom-instructions">
        <span>始终遵循的指令</span>
        <textarea
          id="agentnew-custom-instructions"
          className="agentnew-settings-textarea agentnew-instructions-textarea"
          value={draft}
          rows={10}
          maxLength={MAX_CUSTOM_INSTRUCTIONS_LENGTH}
          disabled={loading}
          placeholder="例如：请始终使用中文回复。"
          aria-describedby="agentnew-custom-instructions-help"
          onChange={(event) => updateCustomInstructionsDraft(event.target.value)}
        />
      </label>

      <p id="agentnew-custom-instructions-help" className="agentnew-instructions-help">
        该内容保存在当前设备，并作为 system 指令发送给主 Agent 和它委派的子 Agent。
        请勿填写密码、令牌等敏感信息。
      </p>

      <div className="agentnew-instructions-footer">
        <span>{draft.length.toLocaleString()} / {MAX_CUSTOM_INSTRUCTIONS_LENGTH.toLocaleString()}</span>
        <button
          type="button"
          className="agentnew-settings-button is-primary"
          disabled={loading || !dirty}
          onClick={() => saveCustomInstructions()}
        >
          保存指令
        </button>
      </div>

      {status.status === 'saved' ? (
        <p className="agentnew-instructions-status is-success" role="status">已保存</p>
      ) : null}
      {status.status === 'error' ? (
        <p className="agentnew-instructions-status is-error" role="alert">{status.error}</p>
      ) : null}
    </section>
  )
}

function PlaceholderPanel() {
  return (
    <section className="agentnew-settings-panel agentnew-settings-placeholder">
      <span aria-hidden="true">⚙</span>
      <h3>通用</h3>
      <p>外观、通知与应用行为设置将在这里提供。</p>
      <small>暂未开放</small>
    </section>
  )
}

/** Owns settings-dialog focus management and routes the active settings panel. */
export function SettingsCenter() {
  const open = useAtomValue(settingsCenterOpenAtom)
  const activeTab = useAtomValue(settingsCenterTabAtom)
  const launchButtonRef = useRef<HTMLButtonElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const wasOpenRef = useRef(false)

  useEffect(() => {
    void hydrateMcpSettings()
    void hydrateAppSettings()
  }, [])

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return

    if (open) {
      wasOpenRef.current = true
      if (!dialog.open) dialog.showModal()
      closeButtonRef.current?.focus()
      return
    }

    if (dialog.open) dialog.close()
    if (wasOpenRef.current) {
      wasOpenRef.current = false
      launchButtonRef.current?.focus()
    }
  }, [open])

  return (
    <>
      <button
        ref={launchButtonRef}
        type="button"
        className="agentnew-settings-launch"
        aria-label="打开设置"
        onClick={() => openSettingsCenter()}
      >
        <span aria-hidden="true">⚙</span>
        设置
      </button>
      <dialog
        ref={dialogRef}
        className="agentnew-settings-modal"
        aria-labelledby="agentnew-settings-title"
        onCancel={(event) => {
          event.preventDefault()
          closeSettingsCenter()
        }}
        onClose={() => {
          if (open) closeSettingsCenter()
          if (wasOpenRef.current) {
            wasOpenRef.current = false
            launchButtonRef.current?.focus()
          }
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return
          const focusableElements = visibleFocusableElements(event.currentTarget)
          const firstElement = focusableElements[0]
          const lastElement = focusableElements.at(-1)
          if (!firstElement || !lastElement) return

          if (event.shiftKey && document.activeElement === firstElement) {
            event.preventDefault()
            lastElement.focus()
          } else if (!event.shiftKey && document.activeElement === lastElement) {
            event.preventDefault()
            firstElement.focus()
          }
        }}
        onMouseDown={(event) => {
          if (event.target !== event.currentTarget) return
          const bounds = event.currentTarget.getBoundingClientRect()
          const insideDialog = event.clientX >= bounds.left
            && event.clientX <= bounds.right
            && event.clientY >= bounds.top
            && event.clientY <= bounds.bottom
          if (!insideDialog) closeSettingsCenter()
        }}
      >
        <header className="agentnew-settings-modal-head">
          <h2 id="agentnew-settings-title">设置</h2>
          <button
            ref={closeButtonRef}
            type="button"
            className="agentnew-settings-close"
            aria-label="关闭设置"
            onClick={() => closeSettingsCenter()}
          >
            ×
          </button>
        </header>
        <div className="agentnew-settings-layout">
          <nav className="agentnew-settings-tabs" aria-label="设置分类">
            {SETTINGS_TABS.map((tab) => (
              <button
                type="button"
                key={tab.id}
                className={`agentnew-settings-tab${activeTab === tab.id ? ' is-active' : ''}`}
                aria-current={activeTab === tab.id ? 'page' : undefined}
                onClick={() => selectSettingsTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </nav>
          <div className="agentnew-settings-content">
            {activeTab === 'mcp'
              ? <McpSettingsPanel />
              : activeTab === 'model'
                ? <ModelCredentialPanel />
                : activeTab === 'instructions'
                  ? <CustomInstructionsPanel />
                  : activeTab === 'skills'
                    ? <ProjectSkillsPanel />
                    : <PlaceholderPanel />}
          </div>
        </div>
      </dialog>
    </>
  )
}
