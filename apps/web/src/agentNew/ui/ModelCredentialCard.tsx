import { useAtomValue } from '@einfach/react'
import {
  deleteModelCredential,
  saveModelCredential,
  updateModelCredentialDraft,
} from '../../settings/commands'
import { MAX_MODEL_API_KEY_LENGTH } from '../../settings/config'
import type {
  CredentialSource,
  ModelCredentialDescriptor,
  ModelCredentialId,
} from '../../settings/modelCredentialHost'
import { modelCredentialEntriesAtom } from '../../settings/state'

function credentialSourceLabel(source: CredentialSource): string {
  if (source === 'config') return '应用配置文件已配置'
  return '未配置密钥'
}

function inputId(id: ModelCredentialId): string {
  return `agentnew-${id}-api-key`
}

/** Renders one write-only desktop credential control. */
export function ModelCredentialCard({
  credential,
}: {
  credential: ModelCredentialDescriptor
}) {
  const entry = useAtomValue(modelCredentialEntriesAtom)[credential.id]
  const loading = entry.state.status === 'idle' || entry.state.status === 'loading'
  const dirty = entry.draft.trim().length > 0
  const id = inputId(credential.id)

  return (
    <div className="agentnew-model-credential" data-provider={credential.target.provider}>
      <label className="agentnew-model-key-field" htmlFor={id}>
        <span>{credential.label} API Key</span>
        <input
          id={id}
          className="agentnew-settings-input"
          type="password"
          value={entry.draft}
          maxLength={MAX_MODEL_API_KEY_LENGTH}
          disabled={loading}
          autoComplete="off"
          spellCheck={false}
          placeholder={`输入新的 ${credential.label} API Key`}
          onChange={(event) => updateModelCredentialDraft(
            credential.id,
            event.target.value,
          )}
        />
      </label>

      <div className="agentnew-model-footer">
        <span>{credentialSourceLabel(entry.state.source)}</span>
        <div>
          <button
            type="button"
            className="agentnew-settings-button"
            disabled={loading || entry.state.source !== 'config'}
            onClick={() => { void deleteModelCredential(credential.id) }}
          >
            删除 {credential.label} 已保存密钥
          </button>
          <button
            type="button"
            className="agentnew-settings-button is-primary"
            disabled={loading || !dirty}
            onClick={() => { void saveModelCredential(credential.id) }}
          >
            保存 {credential.label} 到应用配置
          </button>
        </div>
      </div>

      {entry.state.status === 'saved' ? (
        <p className="agentnew-instructions-status is-success" role="status">
          {credential.label} 密钥设置已保存
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
