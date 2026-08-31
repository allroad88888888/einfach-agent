import { MODEL_CREDENTIALS } from '../../settings/modelCredentialHost'
import { Trans } from '@lingui/react/macro'
import { ModelCredentialCard } from './ModelCredentialCard'
import { ModelEndpointCard } from './ModelEndpointCard'

const OFFICIAL_CREDENTIAL_IDS = new Set([
  'deepseek-default',
  'glm-default',
  'kimi-cn',
])

/** Groups official provider credentials separately from the legacy compatible endpoint. */
export function ModelCredentialGroups({
  kimiVisible,
  legacyVisible,
}: {
  kimiVisible: boolean
  legacyVisible: boolean
}) {
  const officialCredentials = MODEL_CREDENTIALS.filter((credential) => (
    OFFICIAL_CREDENTIAL_IDS.has(credential.id)
    && (credential.id !== 'kimi-cn' || kimiVisible)
  ))
  const legacyCredential = MODEL_CREDENTIALS.find(
    (credential) => credential.id === 'openai-compat-default',
  )

  return (
    <div className="agentnew-model-provider-groups">
      <section aria-labelledby="agentnew-official-models-title">
        <h4 id="agentnew-official-models-title"><Trans>官方模型</Trans></h4>
        <div className="agentnew-model-provider-list">
          {officialCredentials.map((credential) => (
            <details
              key={credential.id}
              className="agentnew-model-provider-card"
              open={credential.id === 'deepseek-default'}
            >
              <summary>
                <strong>{credential.label}</strong>
                <span><Trans>官方直连</Trans></span>
              </summary>
              <ModelCredentialCard credential={credential} />
            </details>
          ))}
        </div>
      </section>

      {legacyVisible && legacyCredential ? (
        <section aria-labelledby="agentnew-legacy-model-title">
          <h4 id="agentnew-legacy-model-title"><Trans>兼容连接迁移</Trans></h4>
          <details className="agentnew-model-provider-card agentnew-model-legacy-card">
            <summary>
              <strong><Trans>旧版单连接（迁移用）</Trans></strong>
              <span><Trans>第三方 / <code>OpenAI</code> 兼容</Trans></span>
            </summary>
            <p className="agentnew-model-routing-note">
              <Trans>仅为已有配置保留。新的第三方或自建模型请使用下方的连接配置。</Trans>
            </p>
            <ModelCredentialCard credential={legacyCredential} />
            <ModelEndpointCard />
          </details>
        </section>
      ) : null}
    </div>
  )
}
