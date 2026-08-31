import type { ReactNode } from 'react'
import { useAtomValue } from '@einfach/react'
import { Trans, useLingui } from '@lingui/react/macro'
import {
  hydrateModelCredentials,
  saveModelCredential,
  updateModelCredentialDraft,
} from '../../settings/commands'
import { MAX_MODEL_API_KEY_LENGTH } from '../../settings/config'
import type { ModelCredentialDescriptor } from '../../settings/modelCredentialHost'
import { MODEL_CREDENTIALS } from '../../settings/modelCredentialHost'
import { modelCredentialEntriesAtom } from '../../settings/state'
import type { StartupCredentialTargetResolution } from '../../settings/startupCredentialTarget'

function credentialFor(id: ModelCredentialDescriptor['id']): ModelCredentialDescriptor | undefined {
  return MODEL_CREDENTIALS.find((credential) => credential.id === id)
}

function blockingDialog(children: ReactNode, ariaLabel: string): ReactNode {
  return (
    <main
      className="agentnew-startup-credential-gate"
      role="dialog"
      aria-label={ariaLabel}
      aria-modal="true"
    >
      <section className="agentnew-startup-credential-card">{children}</section>
    </main>
  )
}

/** Blocks the workspace until the selected model has a configured credential. */
export function StartupCredentialGate({
  enabled,
  target,
  children,
}: {
  enabled: boolean
  target: StartupCredentialTargetResolution
  children: ReactNode
}) {
  const { t } = useLingui()
  const entries = useAtomValue(modelCredentialEntriesAtom)
  const dialogAriaLabel = t`模型密钥门禁`

  if (!enabled) return children

  if (!target.ok) {
    return blockingDialog(
      <>
        <h1><Trans>无法启动当前模型</Trans></h1>
        <p><Trans>当前模型配置不支持凭据管理。请切换到已支持的模型后重试。</Trans></p>
        <p className="agentnew-startup-credential-error" role="alert">{target.error}</p>
      </>,
      dialogAriaLabel,
    )
  }

  const credential = credentialFor(target.id)
  if (!credential) {
    return blockingDialog(
      <>
        <h1><Trans>无法启动当前模型</Trans></h1>
        <p className="agentnew-startup-credential-error" role="alert"><Trans>未找到当前模型的凭据配置。</Trans></p>
      </>,
      dialogAriaLabel,
    )
  }

  const entry = entries[credential.id]
  if (entry.state.configured) return children

  if (entry.state.status === 'idle' || entry.state.status === 'loading') {
    return blockingDialog(
      <>
        <h1><Trans>正在检查模型密钥</Trans></h1>
        <p><Trans>请稍候，正在读取 {credential.label} 的应用配置。</Trans></p>
      </>,
      dialogAriaLabel,
    )
  }

  if (entry.state.status === 'error') {
    return blockingDialog(
      <>
        <h1><Trans>无法读取模型密钥</Trans></h1>
        <p className="agentnew-startup-credential-error" role="alert">{entry.state.error}</p>
        <button
          type="button"
          className="agentnew-startup-credential-button"
          onClick={() => { void hydrateModelCredentials() }}
        >
          <Trans>重试检查</Trans>
        </button>
      </>,
      dialogAriaLabel,
    )
  }

  const inputId = `agentnew-startup-${credential.id}-api-key`
  const dirty = entry.draft.trim().length > 0
  return blockingDialog(
    <>
      <h1><Trans>请输入 {credential.label} API Key</Trans></h1>
      <p><Trans>本机后端会保存到应用配置文件；静态部署会保存到当前浏览器的 localStorage 并直连模型服务。</Trans></p>
      <form
        className="agentnew-startup-credential-form"
        onSubmit={(event) => {
          event.preventDefault()
          void saveModelCredential(credential.id)
        }}
      >
        <label htmlFor={inputId}>
          <Trans>{credential.label} API Key</Trans>
          <input
            id={inputId}
            type="password"
            value={entry.draft}
            maxLength={MAX_MODEL_API_KEY_LENGTH}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            placeholder={t`输入 ${credential.label} API Key`}
            onChange={(event) => updateModelCredentialDraft(credential.id, event.target.value)}
          />
        </label>
        <button
          type="submit"
          className="agentnew-startup-credential-button"
          disabled={!dirty}
        >
          <Trans>保存并进入</Trans>
        </button>
      </form>
    </>,
    dialogAriaLabel,
  )
}
