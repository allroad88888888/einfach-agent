import { useEffect, useRef } from 'react'
import { useAtomValue } from '@einfach/react'
import { DEEPSEEK_FLASH_MODEL, DEFAULT_DEEPSEEK_MODEL } from '@web-agent/ai'
import {
  closeMcpAddForm,
  closeSettingsCenter,
  disconnectMcpServer,
  hydrateMcpSettings,
  openMcpAddForm,
  openSettingsCenter,
  reconnectMcpServer,
  removeMcpServer,
  selectMcpAddMode,
  selectSettingsTab,
  setMcpServerAutoConnect,
  submitMcpDraft,
  submitMcpJsonDraft,
  updateMcpDraft,
  updateMcpJsonDraft,
} from '../../mcp/commands'
import {
  mcpAddModeAtom,
  mcpAddFormOpenAtom,
  mcpDraftAtom,
  mcpDraftValidationAtom,
  mcpFormErrorAtom,
  mcpFormSubmittingAtom,
  mcpHydrationAtom,
  mcpImportStatusAtom,
  mcpJsonDraftAtom,
  mcpPersistenceModeAtom,
  mcpSettingsCapabilitiesAtom,
  mcpServerOperationsAtom,
  mcpServersAtom,
  settingsCenterOpenAtom,
  settingsCenterTabAtom,
} from '../../mcp/state'
import {
  hydrateAppSettings,
  saveCustomInstructions,
  saveDeepSeekApiKey,
  updateCustomInstructionsDraft,
  updateDeepSeekApiKeyDraft,
} from '../../settings/commands'
import {
  MAX_CUSTOM_INSTRUCTIONS_LENGTH,
  MAX_MODEL_API_KEY_LENGTH,
} from '../../settings/config'
import {
  customInstructionsDirtyAtom,
  customInstructionsDraftAtom,
  customInstructionsStatusAtom,
  deepSeekApiKeyDirtyAtom,
  deepSeekApiKeyDraftAtom,
  deepSeekApiKeyStatusAtom,
} from '../../settings/state'
import type {
  McpServerOperation,
  McpServerView,
  SettingsCenterTab,
} from '../../mcp/types'
import { ProjectSkillsPanel } from './ProjectSkillsPanel'

const SETTINGS_TABS: ReadonlyArray<{ id: SettingsCenterTab; label: string }> = [
  { id: 'mcp', label: 'MCP 服务' },
  { id: 'model', label: '模型' },
  { id: 'instructions', label: '自定义指令' },
  { id: 'general', label: '通用' },
  { id: 'skills', label: '项目 Skills' },
]

const TRANSPORT_OPTIONS = [
  { value: 'streamable-http', label: 'Streamable HTTP' },
  { value: 'stdio', label: 'stdio（仅桌面端）' },
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
  return Array.from(
    dialog.querySelectorAll<HTMLElement>(SETTINGS_FOCUSABLE_SELECTOR),
  )
}

function statusLabel(server: McpServerView, operation?: McpServerOperation): string {
  if (operation === 'disconnect') return '注销中'
  if (operation === 'remove') return '删除中'
  const labels = {
    disconnected: '未连接',
    connecting: '连接中',
    reconnecting: '重连中',
    connected: '已连接',
    error: '连接错误',
  }
  return labels[server.status]
}

function ServerCard({
  server,
  operation,
  stdioAvailable,
  temporaryStorage,
}: {
  server: McpServerView
  operation?: McpServerOperation
  stdioAvailable: boolean
  temporaryStorage: boolean
}) {
  const busy = operation !== undefined
  const transportUnavailable = server.transport === 'stdio' && !stdioAvailable
  return (
    <article className="agentnew-mcp-card" aria-label={`MCP 服务 ${server.name}`}>
      <div className="agentnew-mcp-card-head">
        <div>
          <div className="agentnew-mcp-card-title">
            <strong>{server.name}</strong>
            <span className={`agentnew-mcp-status is-${server.status}`}>
              <i aria-hidden="true" />
              {statusLabel(server, operation)}
            </span>
          </div>
          <span className="agentnew-mcp-transport">
            {server.transport === 'streamable-http'
              ? 'Streamable HTTP'
              : `stdio${transportUnavailable ? ' · 仅桌面端' : ''}`}
          </span>
        </div>
        {server.transport === 'stdio' ? (
          <div className="agentnew-mcp-manual-connect">
            <strong>手动连接</strong>
            <small>
              {transportUnavailable
                ? '当前浏览器不可用；本地进程仅能在桌面端启动'
                : '本地进程需每次手动重连'}
            </small>
          </div>
        ) : (
          <label className="agentnew-mcp-auto-connect">
            <span>
              <strong>自动连接</strong>
              <small>
                {temporaryStorage
                  ? '切换会立即连接或注销；偏好仅在本次会话有效'
                  : '切换会立即连接或注销，并保存为启动偏好'}
              </small>
            </span>
            <input
              className="agentnew-settings-checkbox"
              type="checkbox"
              checked={server.autoConnect}
              disabled={busy}
              aria-label={`${server.name} 自动连接`}
              onChange={(event) => {
                void setMcpServerAutoConnect(server.id, event.target.checked)
              }}
            />
          </label>
        )}
      </div>

      <div className="agentnew-mcp-target">
        <span>{server.transport === 'streamable-http' ? '地址' : '命令'}</span>
        <code>{server.target}</code>
      </div>
      {server.args.length > 0 ? (
        <div className="agentnew-mcp-detail">
          参数：{server.args.join(' · ')}
        </div>
      ) : null}
      {server.cwd ? <div className="agentnew-mcp-detail">工作目录：{server.cwd}</div> : null}
      {server.error ? (
        <p className="agentnew-mcp-error" role="alert">{server.error}</p>
      ) : null}

      <div className="agentnew-mcp-card-footer">
        <span>{server.toolCount} 个工具</span>
        <div className="agentnew-mcp-actions">
          <button
            type="button"
            className="agentnew-settings-button is-small"
            disabled={busy || server.status === 'disconnected'}
            onClick={() => void disconnectMcpServer(server.id)}
          >
            {operation === 'disconnect' ? '注销中' : '注销'}
          </button>
          <button
            type="button"
            className="agentnew-settings-button is-small"
            disabled={busy || transportUnavailable}
            title={transportUnavailable ? 'stdio MCP 仅可在桌面端连接' : undefined}
            onClick={() => void reconnectMcpServer(server.id)}
          >
            {operation === 'connect' || operation === 'reconnect' ? '重连中' : '重连'}
          </button>
          <button
            type="button"
            className="agentnew-settings-button is-small is-danger"
            disabled={busy}
            onClick={() => void removeMcpServer(server.id)}
          >
            {operation === 'remove' ? '删除中' : '删除'}
          </button>
        </div>
      </div>
    </article>
  )
}

function AddServerForm({ temporaryStorage }: { temporaryStorage: boolean }) {
  const addMode = useAtomValue(mcpAddModeAtom)
  const draft = useAtomValue(mcpDraftAtom)
  const jsonDraft = useAtomValue(mcpJsonDraftAtom)
  const capabilities = useAtomValue(mcpSettingsCapabilitiesAtom)
  const validation = useAtomValue(mcpDraftValidationAtom)
  const formError = useAtomValue(mcpFormErrorAtom)
  const submitting = useAtomValue(mcpFormSubmittingAtom)
  const submitDisabled = submitting
    || (addMode === 'form' ? !validation.valid : !jsonDraft.trim())

  return (
    <form
      className="agentnew-mcp-form"
      aria-label="添加 MCP 服务"
      onSubmit={(event) => {
        event.preventDefault()
        void (addMode === 'form' ? submitMcpDraft() : submitMcpJsonDraft())
      }}
    >
      <div className="agentnew-mcp-form-head">
        <div>
          <h4>添加 MCP 服务</h4>
          <p>
            连接地址与启动参数会以明文保存；当前不提供请求头、环境变量或令牌字段，请勿填写任何凭据。
          </p>
        </div>
        <button
          type="button"
          className="agentnew-settings-button is-small"
          onClick={() => closeMcpAddForm()}
        >
          取消
        </button>
      </div>

      <div className="agentnew-mcp-add-mode" role="group" aria-label="添加方式">
        <button
          type="button"
          aria-pressed={addMode === 'form'}
          className={addMode === 'form' ? 'is-active' : undefined}
          onClick={() => selectMcpAddMode('form')}
        >
          表单配置
        </button>
        <button
          type="button"
          aria-pressed={addMode === 'json'}
          className={addMode === 'json' ? 'is-active' : undefined}
          onClick={() => selectMcpAddMode('json')}
        >
          JSON 导入
        </button>
      </div>

      {addMode === 'form' ? (
        <div className="agentnew-mcp-form-grid">
          <label>
            <span>服务名称</span>
            <input
              className="agentnew-settings-input"
              value={draft.name}
              placeholder="例如：团队知识库"
              aria-invalid={validation.errors.name ? true : undefined}
              aria-label="服务名称"
              onChange={(event) => updateMcpDraft({ name: event.target.value })}
            />
            {validation.errors.name ? <small>{validation.errors.name}</small> : null}
          </label>

          <label>
            <span>传输方式</span>
            <select
              className="agentnew-settings-select"
              value={draft.transport}
              aria-invalid={validation.errors.transport ? true : undefined}
              aria-label="传输方式"
              onChange={(event) => {
                const value = event.target.value
                if (value === 'streamable-http' || value === 'stdio') {
                  updateMcpDraft({
                    transport: value,
                    ...(value === 'stdio' ? { autoConnect: false } : {}),
                  })
                }
              }}
            >
              {TRANSPORT_OPTIONS.map((option) => (
                <option
                  key={option.value}
                  value={option.value}
                  disabled={option.value === 'stdio' && !capabilities.stdio}
                >
                  {option.label}
                </option>
              ))}
            </select>
            {!capabilities.stdio ? <small>浏览器端仅支持 Streamable HTTP。</small> : null}
            {validation.errors.transport ? <small>{validation.errors.transport}</small> : null}
          </label>

          {draft.transport === 'streamable-http' ? (
            <label className="agentnew-mcp-form-wide">
              <span>服务地址</span>
              <input
                className="agentnew-settings-input"
                value={draft.url}
                placeholder="https://example.com/mcp"
                aria-invalid={validation.errors.url ? true : undefined}
                aria-label="服务地址"
                onChange={(event) => updateMcpDraft({ url: event.target.value })}
              />
              {validation.errors.url ? <small>{validation.errors.url}</small> : null}
            </label>
          ) : (
            <>
              <label className="agentnew-mcp-form-wide">
                <span>启动命令</span>
                <input
                  className="agentnew-settings-input"
                  value={draft.command}
                  placeholder="例如：npx"
                  aria-invalid={validation.errors.command ? true : undefined}
                  aria-label="启动命令"
                  onChange={(event) => updateMcpDraft({ command: event.target.value })}
                />
                {validation.errors.command ? <small>{validation.errors.command}</small> : null}
              </label>
              <label className="agentnew-mcp-form-wide">
                <span>启动参数（每行一项）</span>
                <textarea
                  className="agentnew-settings-textarea"
                  value={draft.argsText}
                  rows={3}
                  placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/path/to/workspace'}
                  aria-invalid={validation.errors.argsText ? true : undefined}
                  aria-label="启动参数"
                  onChange={(event) => updateMcpDraft({ argsText: event.target.value })}
                />
                {validation.errors.argsText ? <small>{validation.errors.argsText}</small> : null}
              </label>
              <label className="agentnew-mcp-form-wide">
                <span>工作目录（可选）</span>
                <input
                  className="agentnew-settings-input"
                  value={draft.cwd}
                  placeholder="/path/to/workspace"
                  aria-invalid={validation.errors.cwd ? true : undefined}
                  aria-label="工作目录"
                  onChange={(event) => updateMcpDraft({ cwd: event.target.value })}
                />
                {validation.errors.cwd ? <small>{validation.errors.cwd}</small> : null}
              </label>
            </>
          )}

          {draft.transport === 'stdio' ? (
            <div className="agentnew-mcp-form-manual agentnew-mcp-form-wide" role="note">
              <strong>仅手动连接</strong>
              <small>stdio 会启动本地进程，不会从浏览器存储自动执行；每次启动应用后请手动重连。</small>
            </div>
          ) : (
            <label className="agentnew-mcp-form-switch agentnew-mcp-form-wide">
              <span>
                <strong>保存后自动连接</strong>
                <small>
                  {temporaryStorage
                    ? '开启后会立即连接；配置和偏好仅在本次会话有效。'
                    : '开启后保存即连接；开关变化也会立即连接或注销，并作为下次启动偏好。'}
                </small>
              </span>
              <input
                className="agentnew-settings-checkbox"
                type="checkbox"
                checked={draft.autoConnect}
                aria-label="保存后自动连接"
                onChange={(event) => updateMcpDraft({ autoConnect: event.target.checked })}
              />
            </label>
          )}
        </div>
      ) : (
        <div className="agentnew-mcp-json-panel">
          <label htmlFor="agentnew-mcp-json-input">MCP JSON 配置</label>
          <textarea
            id="agentnew-mcp-json-input"
            className="agentnew-settings-textarea agentnew-mcp-json-input"
            value={jsonDraft}
            rows={13}
            spellCheck={false}
            aria-invalid={formError ? true : undefined}
            aria-describedby={
              formError
                ? 'agentnew-mcp-json-help agentnew-mcp-form-error'
                : 'agentnew-mcp-json-help'
            }
            onChange={(event) => updateMcpJsonDraft(event.target.value)}
          />
          <p id="agentnew-mcp-json-help">
            支持标准 <code>mcpServers</code> 对象，可一次导入多个服务。导入只保存配置，
            不会自动连接；不支持的字段会明确报错，不会静默丢弃。
          </p>
          <div className="agentnew-mcp-form-manual" role="note">
            <strong>{capabilities.stdio ? '本地服务需手动连接' : '当前是浏览器环境'}</strong>
            <small>
              {capabilities.stdio
                ? '含 command 的 stdio 服务导入后保持未连接，请在列表中手动重连。'
                : '含 command 的 stdio 配置可以保存，但浏览器无法启动；请在桌面端重新导入或配置后手动连接。'}
            </small>
          </div>
        </div>
      )}

      {formError ? (
        <p id="agentnew-mcp-form-error" className="agentnew-mcp-form-error" role="alert">
          {formError}
        </p>
      ) : null}
      <div className="agentnew-mcp-form-submit">
        <button
          type="submit"
          className="agentnew-settings-button is-primary"
          disabled={submitDisabled}
        >
          {submitting
            ? (addMode === 'form' ? '保存中' : '导入中')
            : (addMode === 'form' ? '保存服务' : '导入配置')}
        </button>
      </div>
    </form>
  )
}

function McpSettingsPanel() {
  const servers = useAtomValue(mcpServersAtom)
  const capabilities = useAtomValue(mcpSettingsCapabilitiesAtom)
  const operations = useAtomValue(mcpServerOperationsAtom)
  const hydration = useAtomValue(mcpHydrationAtom)
  const importStatus = useAtomValue(mcpImportStatusAtom)
  const persistenceMode = useAtomValue(mcpPersistenceModeAtom)
  const addFormOpen = useAtomValue(mcpAddFormOpenAtom)
  const temporaryStorage = persistenceMode === 'temporary'

  return (
    <section className="agentnew-settings-panel" aria-labelledby="agentnew-mcp-settings-title">
      <div className="agentnew-settings-panel-head">
        <div>
          <h3 id="agentnew-mcp-settings-title">MCP 服务</h3>
          <p>连接外部工具服务，并把远端工具安全地提供给当前 Agent。</p>
        </div>
        <button
          type="button"
          className="agentnew-settings-button is-primary"
          onClick={() => addFormOpen ? closeMcpAddForm() : openMcpAddForm()}
        >
          {addFormOpen ? '收起表单' : '+ 添加服务'}
        </button>
      </div>

      {temporaryStorage ? (
        <div
          className="agentnew-mcp-storage-warning"
          role="status"
          aria-label="MCP 存储状态"
        >
          <strong>临时存储模式</strong>
          <span>
            浏览器持久化存储不可用。MCP 配置仅保存在当前会话，刷新或关闭页面后会丢失。
          </span>
        </div>
      ) : null}

      {addFormOpen ? <AddServerForm temporaryStorage={temporaryStorage} /> : null}
      {importStatus ? (
        <p className="agentnew-mcp-import-status" role="status">{importStatus}</p>
      ) : null}
      {hydration.status === 'loading' ? (
        <p className="agentnew-mcp-notice" role="status">正在恢复 MCP 服务…</p>
      ) : null}
      {hydration.status === 'error' ? (
        <p className="agentnew-mcp-error" role="alert">{hydration.error}</p>
      ) : null}

      {servers.length > 0 ? (
        <div className="agentnew-mcp-list">
          {servers.map((server) => (
            <ServerCard
              key={server.id}
              server={server}
              operation={operations[server.id]}
              stdioAvailable={capabilities.stdio}
              temporaryStorage={temporaryStorage}
            />
          ))}
        </div>
      ) : hydration.status !== 'loading' ? (
        <div className="agentnew-mcp-empty">
          <span aria-hidden="true">⌁</span>
          <strong>还没有 MCP 服务</strong>
          <p>
            添加 Streamable HTTP 服务开始使用外部工具
            {capabilities.stdio ? '，桌面端也可使用 stdio。' : '；stdio 仅在桌面端可用。'}
          </p>
        </div>
      ) : null}
    </section>
  )
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

function ModelSettingsPanel() {
  const apiKeyDraft = useAtomValue(deepSeekApiKeyDraftAtom)
  const dirty = useAtomValue(deepSeekApiKeyDirtyAtom)
  const status = useAtomValue(deepSeekApiKeyStatusAtom)
  const loading = status.status === 'idle' || status.status === 'loading'

  return (
    <section
      className="agentnew-settings-panel agentnew-model-panel"
      aria-labelledby="agentnew-model-settings-title"
    >
      <div className="agentnew-settings-panel-head">
        <div>
          <h3 id="agentnew-model-settings-title">模型</h3>
          <p>主 Agent 固定使用 Pro，并为简单子任务选择 Flash。</p>
        </div>
      </div>

      <div className="agentnew-model-summary" aria-label="模型分工">
        <div>
          <span>供应商</span>
          <strong>DeepSeek</strong>
        </div>
        <div>
          <span>主 Agent</span>
          <code>{DEFAULT_DEEPSEEK_MODEL}</code>
          <small>DeepSeek V4 Pro</small>
        </div>
        <div>
          <span>简单子 Agent</span>
          <code>{DEEPSEEK_FLASH_MODEL}</code>
          <small>DeepSeek V4 Flash</small>
        </div>
      </div>
      <p className="agentnew-model-routing-note">
        Flash 只用于主 Agent 明确判定为范围清楚、风险低且容易验证的直接子任务；未指定时使用 Pro。
      </p>

      <label className="agentnew-model-key-field" htmlFor="agentnew-deepseek-api-key">
        <span>DeepSeek API Key</span>
        <input
          id="agentnew-deepseek-api-key"
          className="agentnew-settings-input"
          type="password"
          value={apiKeyDraft}
          maxLength={MAX_MODEL_API_KEY_LENGTH}
          disabled={loading}
          autoComplete="off"
          spellCheck={false}
          placeholder="输入 DeepSeek API Key"
          aria-describedby="agentnew-deepseek-api-key-help"
          onChange={(event) => updateDeepSeekApiKeyDraft(event.target.value)}
        />
      </label>

      <p id="agentnew-deepseek-api-key-help" className="agentnew-model-help">
        保存后立即用于新的模型请求；留空保存时回退到
        <code> VITE_DEEPSEEK_API_KEY</code>（若启动环境已配置）。
      </p>
      <p className="agentnew-model-security-note">
        密钥保存在当前设备的应用存储中，并非系统钥匙串；请勿在共享设备上保存。
      </p>

      <div className="agentnew-model-footer">
        <span>{apiKeyDraft ? '已填写密钥' : '未保存密钥'}</span>
        <button
          type="button"
          className="agentnew-settings-button is-primary"
          disabled={loading || !dirty}
          onClick={() => saveDeepSeekApiKey()}
        >
          保存模型设置
        </button>
      </div>

      {status.status === 'saved' ? (
        <p className="agentnew-instructions-status is-success" role="status">模型设置已保存</p>
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

export function SettingsCenter() {
  const open = useAtomValue(settingsCenterOpenAtom)
  const activeTab = useAtomValue(settingsCenterTabAtom)
  const launchButtonRef = useRef<HTMLButtonElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const wasOpenRef = useRef(false)

  useEffect(() => {
    void hydrateMcpSettings()
    hydrateAppSettings()
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
                ? <ModelSettingsPanel />
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
