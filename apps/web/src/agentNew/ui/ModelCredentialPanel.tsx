import { useAtomValue } from '@einfach/react'
import { DEEPSEEK_FLASH_MODEL, DEFAULT_DEEPSEEK_MODEL } from '@web-agent/ai'
import {
  deleteDeepSeekApiKey,
  saveDeepSeekApiKey,
  updateDeepSeekApiKeyDraft,
} from '../../settings/commands'
import { MAX_MODEL_API_KEY_LENGTH } from '../../settings/config'
import {
  deepSeekApiKeyDirtyAtom,
  deepSeekApiKeyDraftAtom,
  deepSeekApiKeyStatusAtom,
} from '../../settings/state'

function credentialSourceLabel(source: 'keychain' | 'environment' | 'missing'): string {
  if (source === 'keychain') return '系统钥匙串已配置'
  if (source === 'environment') return '桌面进程环境变量已配置'
  return '未配置密钥'
}

/** Renders desktop credential controls without ever reading a saved credential. */
export function ModelCredentialPanel() {
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
        <div><span>供应商</span><strong>DeepSeek</strong></div>
        <div><span>主 Agent</span><code>{DEFAULT_DEEPSEEK_MODEL}</code><small>DeepSeek V4 Pro</small></div>
        <div><span>简单子 Agent</span><code>{DEEPSEEK_FLASH_MODEL}</code><small>DeepSeek V4 Flash</small></div>
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
          placeholder="输入新的 DeepSeek API Key"
          aria-describedby="agentnew-deepseek-api-key-help"
          onChange={(event) => updateDeepSeekApiKeyDraft(event.target.value)}
        />
      </label>

      <p id="agentnew-deepseek-api-key-help" className="agentnew-model-help">
        仅桌面应用可保存密钥；静态 Web 部署不会直连模型服务。
      </p>
      <p className="agentnew-model-security-note">
        保存的密钥仅由桌面原生层写入系统钥匙串，前端不会持久化或读取已保存的值。
      </p>

      <div className="agentnew-model-footer">
        <span>{credentialSourceLabel(status.source)}</span>
        <div>
          <button
            type="button"
            className="agentnew-settings-button"
            disabled={loading || status.source !== 'keychain'}
            onClick={() => { void deleteDeepSeekApiKey() }}
          >
            删除钥匙串密钥
          </button>
          <button
            type="button"
            className="agentnew-settings-button is-primary"
            disabled={loading || !dirty}
            onClick={() => { void saveDeepSeekApiKey() }}
          >
            保存到系统钥匙串
          </button>
        </div>
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
