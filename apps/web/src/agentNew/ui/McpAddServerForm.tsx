import { useAtomValue } from '@einfach/react'
import { Trans, useLingui } from '@lingui/react/macro'
import {
  closeMcpAddForm,
  selectMcpAddMode,
  submitMcpDraft,
  submitMcpJsonDraft,
  updateMcpDraft,
  updateMcpJsonDraft,
} from '../../mcp/commands'
import {
  mcpAddModeAtom,
  mcpDraftAtom,
  mcpDraftValidationAtom,
  mcpFormErrorAtom,
  mcpFormSubmittingAtom,
  mcpJsonDraftAtom,
  mcpSettingsCapabilitiesAtom,
} from '../../mcp/state'
import { McpCredentialField } from './McpCredentialField'

const TRANSPORT_OPTIONS = ['streamable-http', 'stdio'] as const

/** Edits a single MCP configuration or imports a standard MCP JSON document. */
export function McpAddServerForm({ temporaryStorage }: { temporaryStorage: boolean }) {
  const { t } = useLingui()
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
      aria-label={t`添加 MCP 服务`}
      onSubmit={(event) => {
        event.preventDefault()
        void (addMode === 'form' ? submitMcpDraft() : submitMcpJsonDraft())
      }}
    >
      <div className="agentnew-mcp-form-head">
        <div>
          <h4><Trans>添加 MCP 服务</Trans></h4>
          <p>
            <Trans>连接地址与启动参数会以明文保存，请勿在其中填写凭据；请求头 / 环境变量仅在桌面端可以填写，并只会保存到桌面本地配置文件。</Trans>
          </p>
        </div>
        <button
          type="button"
          className="agentnew-settings-button is-small"
          onClick={() => closeMcpAddForm()}
        >
          <Trans>取消</Trans>
        </button>
      </div>

      <div className="agentnew-mcp-add-mode" role="group" aria-label={t`添加方式`}>
        <button
          type="button"
          aria-pressed={addMode === 'form'}
          className={addMode === 'form' ? 'is-active' : undefined}
          onClick={() => selectMcpAddMode('form')}
        >
          <Trans>表单配置</Trans>
        </button>
        <button
          type="button"
          aria-pressed={addMode === 'json'}
          className={addMode === 'json' ? 'is-active' : undefined}
          onClick={() => selectMcpAddMode('json')}
        >
          <Trans>JSON 导入</Trans>
        </button>
      </div>

      {addMode === 'form' ? (
        <div className="agentnew-mcp-form-grid">
          <label>
            <span><Trans>服务名称</Trans></span>
            <input
              className="agentnew-settings-input"
              value={draft.name}
              placeholder={t`例如：团队知识库`}
              aria-invalid={validation.errors.name ? true : undefined}
              aria-label={t`服务名称`}
              onChange={(event) => updateMcpDraft({ name: event.target.value })}
            />
            {validation.errors.name ? <small>{validation.errors.name}</small> : null}
          </label>

          <label>
            <span><Trans>传输方式</Trans></span>
            <select
              className="agentnew-settings-select"
              value={draft.transport}
              aria-invalid={validation.errors.transport ? true : undefined}
              aria-label={t`传输方式`}
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
                  key={option}
                  value={option}
                  disabled={option === 'stdio' && !capabilities.stdio}
                >
                  {option === 'stdio' ? t`stdio（仅桌面端）` : 'Streamable HTTP'}
                </option>
              ))}
            </select>
            {!capabilities.stdio ? <small><Trans>浏览器端仅支持 Streamable HTTP。</Trans></small> : null}
            {validation.errors.transport ? <small>{validation.errors.transport}</small> : null}
          </label>

          {draft.transport === 'streamable-http' ? (
            <>
              <label className="agentnew-mcp-form-wide">
                <span><Trans>服务地址</Trans></span>
                <input
                  className="agentnew-settings-input"
                  value={draft.url}
                  placeholder="https://example.com/mcp"
                  aria-invalid={validation.errors.url ? true : undefined}
                  aria-label={t`服务地址`}
                  onChange={(event) => updateMcpDraft({ url: event.target.value })}
                />
                {validation.errors.url ? <small>{validation.errors.url}</small> : null}
              </label>
              <McpCredentialField
                id="agentnew-mcp-headers-input"
                label={t`请求头（可选）`}
                value={draft.headersText ?? ''}
                placeholder={'Authorization=Bearer sk-...\nX-Api-Key=...'}
                formatHint={t`每行一项，格式为 键=值；用于向服务端发送鉴权信息。`}
                disabled={!capabilities.credentials}
                disabledHint={t`凭据字段仅桌面端支持`}
                error={validation.errors.headersText}
                onChange={(value) => updateMcpDraft({ headersText: value })}
              />
            </>
          ) : (
            <>
              <label className="agentnew-mcp-form-wide">
                <span><Trans>启动命令</Trans></span>
                <input
                  className="agentnew-settings-input"
                  value={draft.command}
                  placeholder={t`例如：npx`}
                  aria-invalid={validation.errors.command ? true : undefined}
                  aria-label={t`启动命令`}
                  onChange={(event) => updateMcpDraft({ command: event.target.value })}
                />
                {validation.errors.command ? <small>{validation.errors.command}</small> : null}
              </label>
              <label className="agentnew-mcp-form-wide">
                <span><Trans>启动参数（每行一项）</Trans></span>
                <textarea
                  className="agentnew-settings-textarea"
                  value={draft.argsText}
                  rows={3}
                  placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/path/to/workspace'}
                  aria-invalid={validation.errors.argsText ? true : undefined}
                  aria-label={t`启动参数`}
                  onChange={(event) => updateMcpDraft({ argsText: event.target.value })}
                />
                {validation.errors.argsText ? <small>{validation.errors.argsText}</small> : null}
              </label>
              <label className="agentnew-mcp-form-wide">
                <span><Trans>工作目录（可选）</Trans></span>
                <input
                  className="agentnew-settings-input"
                  value={draft.cwd}
                  placeholder="/path/to/workspace"
                  aria-invalid={validation.errors.cwd ? true : undefined}
                  aria-label={t`工作目录`}
                  onChange={(event) => updateMcpDraft({ cwd: event.target.value })}
                />
                {validation.errors.cwd ? <small>{validation.errors.cwd}</small> : null}
              </label>
              <McpCredentialField
                id="agentnew-mcp-env-input"
                label={t`环境变量（可选）`}
                value={draft.envText ?? ''}
                placeholder={'API_KEY=sk-...\nTOKEN=...'}
                formatHint={t`每行一项，格式为 键=值；用于向子进程传递凭据，不会出现在启动参数里。`}
                disabled={!capabilities.credentials}
                disabledHint={t`凭据字段仅桌面端支持`}
                error={validation.errors.envText}
                onChange={(value) => updateMcpDraft({ envText: value })}
              />
            </>
          )}

          {/*
            stdio 也有这个开关（H2）：它只是「要不要每次启动都连」的偏好，能不能真的
            执行由保存后的那一次命令行确认决定，勾上它不会让任何命令悄悄跑起来。
            默认仍然是关（切到 stdio 时置 false），本地进程该由用户明确要求才常驻。
          */}
          <label className="agentnew-mcp-form-switch agentnew-mcp-form-wide">
            <span>
              <strong><Trans>保存后自动连接</Trans></strong>
              <small>
                {draft.transport === 'stdio'
                  ? t`保存后会先请你确认将执行的命令；确认后立即执行，并在之后每次启动时自动执行。`
                  : temporaryStorage
                    ? t`开启后会立即连接；配置和偏好仅在本次会话有效。`
                    : t`开启后保存即连接；开关变化也会立即连接或注销，并作为下次启动偏好。`}
              </small>
            </span>
            <input
              className="agentnew-settings-checkbox"
              type="checkbox"
              checked={draft.autoConnect}
              aria-label={t`保存后自动连接`}
              onChange={(event) => updateMcpDraft({ autoConnect: event.target.checked })}
            />
          </label>
          {draft.transport === 'stdio' ? (
            <div className="agentnew-mcp-form-manual agentnew-mcp-form-wide" role="note">
              <strong><Trans>会在本机启动进程</Trans></strong>
              <small><Trans>保存后会把完整命令行摆出来请你确认；未确认前不会执行任何命令。</Trans></small>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="agentnew-mcp-json-panel">
          <label htmlFor="agentnew-mcp-json-input"><Trans>MCP JSON 配置</Trans></label>
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
            <Trans>支持标准 <code>mcpServers</code> 对象，可一次导入多个服务。导入只保存配置，不会自动连接；不支持的字段会明确报错，不会静默丢弃。</Trans>
          </p>
          <div className="agentnew-mcp-form-manual" role="note">
            <strong>{capabilities.stdio ? t`本地服务需先确认命令` : t`当前是浏览器环境`}</strong>
            <small>
              {capabilities.stdio
                ? t`含 command 的 stdio 服务导入后保持未连接，每个服务的卡片上会请你确认将执行的命令。`
                : t`含 command 的 stdio 配置可以保存，但浏览器无法启动；请在桌面端重新导入或配置后手动连接。`}
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
            ? (addMode === 'form' ? t`保存中` : t`导入中`)
            : (addMode === 'form' ? t`保存服务` : t`导入配置`)}
        </button>
      </div>
    </form>
  )
}
