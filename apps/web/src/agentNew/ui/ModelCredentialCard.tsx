import { useAtomValue } from '@einfach/react'
import { Trans, useLingui } from '@lingui/react/macro'
import {
  deleteModelCredential,
  saveModelCredential,
  updateModelCredentialDraft,
} from '../../settings/commands'
import { MAX_MODEL_API_KEY_LENGTH } from '../../settings/config'
import type {
  ModelCredentialDescriptor,
  ModelCredentialId,
} from '../../settings/modelCredentialHost'
import { modelCredentialEntriesAtom } from '../../settings/state'

function inputId(id: ModelCredentialId): string {
  return `agentnew-${id}-api-key`
}

/** Renders one write-only model credential control. */
export function ModelCredentialCard({
  credential,
}: {
  credential: ModelCredentialDescriptor
}) {
  const { t } = useLingui()
  const entry = useAtomValue(modelCredentialEntriesAtom)[credential.id]
  const loading = entry.state.status === 'idle' || entry.state.status === 'loading'
  const dirty = entry.draft.trim().length > 0
  const id = inputId(credential.id)

  return (
    <div className="agentnew-model-credential" data-provider={credential.target.provider}>
      <label className="agentnew-model-key-field" htmlFor={id}>
        <span><Trans>{credential.label} API Key</Trans></span>
        <input
          id={id}
          className="agentnew-settings-input"
          type="password"
          value={entry.draft}
          maxLength={MAX_MODEL_API_KEY_LENGTH}
          disabled={loading}
          autoComplete="off"
          spellCheck={false}
          placeholder={t`输入新的 ${credential.label} API Key`}
          onChange={(event) => updateModelCredentialDraft(
            credential.id,
            event.target.value,
          )}
        />
      </label>

      <div className="agentnew-model-footer">
        <span>
          {entry.state.source === 'browser'
            ? t`浏览器本地存储已配置`
            : entry.state.source === 'config'
              ? t`应用配置文件已配置`
              : t`未配置密钥`}
        </span>
        <div>
          <button
            type="button"
            className="agentnew-settings-button"
            disabled={loading || entry.state.source === 'missing'}
            onClick={() => { void deleteModelCredential(credential.id) }}
          >
            <Trans>删除 {credential.label} 已保存密钥</Trans>
          </button>
          <button
            type="button"
            className="agentnew-settings-button is-primary"
            disabled={loading || !dirty}
            onClick={() => { void saveModelCredential(credential.id) }}
          >
            <Trans>保存 {credential.label} API Key</Trans>
          </button>
        </div>
      </div>

      {entry.state.status === 'saved' ? (
        <p className="agentnew-instructions-status is-success" role="status">
          <Trans>{credential.label} 密钥设置已保存</Trans>
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
