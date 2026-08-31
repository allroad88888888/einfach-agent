import { Trans, useLingui } from '@lingui/react/macro'

export type ModelConnectionProfileEditorMode = 'create' | 'edit'
export type ModelConnectionProfileEditorField = 'id' | 'label' | 'baseUrl' | 'apiKey'

export interface ModelConnectionProfileEditorProps {
  mode: ModelConnectionProfileEditorMode
  id: string
  label: string
  baseUrl: string
  apiKey: string
  probing?: boolean
  status?: string
  error?: string
  children?: React.ReactNode
  onChange: (field: ModelConnectionProfileEditorField, value: string) => void
  onProbe: () => void
  onSave: () => void
  onCancel: () => void
}

/** Controlled editor for connection metadata and its write-only credential. */
export function ModelConnectionProfileEditor({
  mode, id, label, baseUrl, apiKey, probing, status, error, children,
  onChange, onProbe, onSave, onCancel,
}: ModelConnectionProfileEditorProps) {
  const { t } = useLingui()
  const prefix = `agentnew-model-connection-editor-${mode}`
  const editing = mode === 'edit'
  return (
    <form className="agentnew-model-connection-editor" aria-label={editing ? t`编辑模型连接` : t`新建模型连接`}
      onSubmit={(event) => { event.preventDefault(); onSave() }}>
      <header className="agentnew-model-connection-editor-head">
        <div>
          <span>{editing ? <Trans>连接配置</Trans> : <Trans>新连接</Trans>}</span>
          <h3>{editing ? <Trans>编辑兼容连接</Trans> : <Trans>添加兼容连接</Trans>}</h3>
          <p>{editing
            ? <Trans>更新地址、可用模型或密钥。连接 ID 创建后保持不变。</Trans>
            : <Trans>用于第三方托管、自建或本地部署的 <code>OpenAI</code> 兼容服务。</Trans>}</p>
        </div>
        <button type="button" className="agentnew-settings-button is-small" aria-label={t`关闭编辑器`} onClick={onCancel}><Trans>取消</Trans></button>
      </header>
      <div className="agentnew-model-connection-editor-fields">
        <label htmlFor={`${prefix}-id`}><Trans>连接 ID</Trans>
          <input id={`${prefix}-id`} className="agentnew-settings-input" value={id} disabled={editing} autoComplete="off"
            onChange={(event) => onChange('id', event.target.value)} />
        </label>
        <label htmlFor={`${prefix}-label`}><Trans>名称</Trans>
          <input id={`${prefix}-label`} className="agentnew-settings-input" value={label}
            onChange={(event) => onChange('label', event.target.value)} />
        </label>
        <label className="agentnew-model-connection-editor-wide" htmlFor={`${prefix}-base-url`}>Base URL
          <input id={`${prefix}-base-url`} className="agentnew-settings-input" type="url" inputMode="url" value={baseUrl}
            onChange={(event) => onChange('baseUrl', event.target.value)} />
        </label>
        <label className="agentnew-model-connection-editor-wide" htmlFor={`${prefix}-api-key`}><Trans>API Key（写入后不会显示）</Trans>
          <input id={`${prefix}-api-key`} className="agentnew-settings-input" type="password" value={apiKey} autoComplete="new-password"
            onChange={(event) => onChange('apiKey', event.target.value)} />
        </label>
      </div>
      <p className="agentnew-model-connection-editor-key-note" role="note">
        <Trans>API Key 只用于保存和本次测试；保存成功后不会回显。编辑时留空表示保持已有 Key。</Trans>
      </p>
      <div className="agentnew-model-connection-editor-probe">
        <div><strong><Trans>可用模型</Trans></strong><span><Trans>先测试连接，再从返回结果中选择；也可以手动添加。</Trans></span></div>
        <button type="button" className="agentnew-settings-button" disabled={probing || !baseUrl.trim()} onClick={onProbe}>
          {probing ? <Trans>正在发现模型…</Trans> : <Trans>测试连接</Trans>}
        </button>
      </div>
      {children}
      {status ? <p role="status">{status}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <div className="agentnew-model-connection-editor-actions">
        <button type="submit" className="agentnew-settings-button is-primary">{editing ? <Trans>保存编辑</Trans> : <Trans>创建连接</Trans>}</button>
        <button type="button" className="agentnew-settings-button" onClick={onCancel}><Trans>取消</Trans></button>
      </div>
    </form>
  )
}
