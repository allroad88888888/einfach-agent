import { useAtomValue } from '@einfach/react'
import {
  deleteModelEndpoint,
  saveModelEndpoint,
  updateModelEndpointDraft,
} from '../../settings/commands'
import {
  MAX_MODEL_ENDPOINT_LENGTH,
  MODEL_ENDPOINT_RULE_HINT,
} from '../../settings/modelEndpointHost'
import { modelEndpointEntryAtom } from '../../settings/state'

const INPUT_ID = 'agentnew-openai-compat-base-url'

/**
 * openai-compat 的接入点登记控件。
 *
 * 与凭据那张卡的**一处刻意差异**：这里的输入框是 `type="text"` 且已登记的地址会显示出来。
 * 接入点不是秘密，用户必须看得见自己登记的是哪个地址，否则「我到底连到哪了」永远答不出来；
 * Key 相反，永远不回显。
 */
export function ModelEndpointCard() {
  const entry = useAtomValue(modelEndpointEntryAtom)
  const loading = entry.state.status === 'idle' || entry.state.status === 'loading'
  const dirty = entry.draft.trim().length > 0

  return (
    <div className="agentnew-model-credential" data-provider="openai-compat">
      <label className="agentnew-model-key-field" htmlFor={INPUT_ID}>
        <span>OpenAI 兼容端点接入点</span>
        <input
          id={INPUT_ID}
          className="agentnew-settings-input"
          type="text"
          value={entry.draft}
          maxLength={MAX_MODEL_ENDPOINT_LENGTH}
          disabled={loading}
          autoComplete="off"
          spellCheck={false}
          placeholder="https://gateway.example.com/v1"
          onChange={(event) => updateModelEndpointDraft(event.target.value)}
        />
      </label>
      <p className="agentnew-model-help">{MODEL_ENDPOINT_RULE_HINT}</p>

      <div className="agentnew-model-footer">
        <span>
          {entry.state.configured && entry.state.baseUrl
            ? `已登记：${entry.state.baseUrl}`
            : '未登记接入点（登记之前不会向任何地址发出请求）'}
        </span>
        <div>
          <button
            type="button"
            className="agentnew-settings-button"
            disabled={loading || !entry.state.configured}
            onClick={() => { void deleteModelEndpoint() }}
          >
            删除已登记接入点
          </button>
          <button
            type="button"
            className="agentnew-settings-button is-primary"
            disabled={loading || !dirty}
            onClick={() => { void saveModelEndpoint() }}
          >
            保存接入点到应用配置
          </button>
        </div>
      </div>

      {entry.state.status === 'saved' ? (
        <p className="agentnew-instructions-status is-success" role="status">
          接入点设置已保存
        </p>
      ) : null}
      {entry.state.status === 'error' ? (
        <p className="agentnew-instructions-status is-error" role="alert">
          {entry.state.error}
        </p>
      ) : null}
    </div>
  )
}
