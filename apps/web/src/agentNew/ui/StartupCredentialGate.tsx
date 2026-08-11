import type { ReactNode } from 'react'
import { useAtomValue } from '@einfach/react'
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

function blockingDialog(children: ReactNode): ReactNode {
  return (
    <main
      className="agentnew-startup-credential-gate"
      role="dialog"
      aria-label="模型密钥门禁"
      aria-modal="true"
    >
      <section className="agentnew-startup-credential-card">{children}</section>
    </main>
  )
}

/** Blocks the desktop workspace until its selected model has a configured credential. */
export function StartupCredentialGate({
  enabled,
  target,
  children,
}: {
  enabled: boolean
  target: StartupCredentialTargetResolution
  children: ReactNode
}) {
  const entries = useAtomValue(modelCredentialEntriesAtom)

  if (!enabled) return children

  if (!target.ok) {
    return blockingDialog(
      <>
        <h1>无法启动当前模型</h1>
        <p>当前模型配置不支持桌面凭据管理。请切换到已支持的模型后重试。</p>
        <p className="agentnew-startup-credential-error" role="alert">{target.error}</p>
      </>,
    )
  }

  const credential = credentialFor(target.id)
  if (!credential) {
    return blockingDialog(
      <>
        <h1>无法启动当前模型</h1>
        <p className="agentnew-startup-credential-error" role="alert">未找到当前模型的凭据配置。</p>
      </>,
    )
  }

  const entry = entries[credential.id]
  if (entry.state.configured) return children

  if (entry.state.status === 'idle' || entry.state.status === 'loading') {
    return blockingDialog(
      <>
        <h1>正在检查模型密钥</h1>
        <p>请稍候，正在读取 {credential.label} 的应用配置。</p>
      </>,
    )
  }

  if (entry.state.status === 'error') {
    return blockingDialog(
      <>
        <h1>无法读取模型密钥</h1>
        <p className="agentnew-startup-credential-error" role="alert">{entry.state.error}</p>
        <button
          type="button"
          className="agentnew-startup-credential-button"
          onClick={() => { void hydrateModelCredentials() }}
        >
          重试检查
        </button>
      </>,
    )
  }

  const inputId = `agentnew-startup-${credential.id}-api-key`
  const dirty = entry.draft.trim().length > 0
  return blockingDialog(
    <>
      <h1>请输入 {credential.label} API Key</h1>
      <p>密钥只会保存到本机应用配置文件，不会显示或写入网页设置。</p>
      <form
        className="agentnew-startup-credential-form"
        onSubmit={(event) => {
          event.preventDefault()
          void saveModelCredential(credential.id)
        }}
      >
        <label htmlFor={inputId}>
          {credential.label} API Key
          <input
            id={inputId}
            type="password"
            value={entry.draft}
            maxLength={MAX_MODEL_API_KEY_LENGTH}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            placeholder={`输入 ${credential.label} API Key`}
            onChange={(event) => updateModelCredentialDraft(credential.id, event.target.value)}
          />
        </label>
        <button
          type="submit"
          className="agentnew-startup-credential-button"
          disabled={!dirty}
        >
          保存并进入
        </button>
      </form>
    </>,
  )
}
