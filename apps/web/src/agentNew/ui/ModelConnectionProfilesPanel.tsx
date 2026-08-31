import type { ConnectionProfileModel, ModelConnectionProfile } from '../../settings/modelConnectionProfileHost'
import { Trans, useLingui } from '@lingui/react/macro'

export interface ModelConnectionProfilesPanelProps {
  profiles: readonly ModelConnectionProfile[]
  current?: { id: string; model: string }
  onNewProfile?: () => void
  onEditProfile?: (profile: ModelConnectionProfile) => void
  onDeleteProfile?: (profile: ModelConnectionProfile) => void
  onUseModel?: (profile: ModelConnectionProfile, model: ConnectionProfileModel) => void
  onSetDefaultModel?: (profile: ModelConnectionProfile, model: ConnectionProfileModel) => void
}

function ProfileCard({ profile, open, current, actions }: {
  profile: ModelConnectionProfile
  open: boolean
  current?: { id: string; model: string }
  actions: Pick<ModelConnectionProfilesPanelProps, 'onEditProfile' | 'onDeleteProfile' | 'onUseModel' | 'onSetDefaultModel'>
}) {
  const { t } = useLingui()
  return <details className="agentnew-model-connection-card" name="model-connection-profile" open={open}>
    <summary className="agentnew-model-connection-summary"><span><strong>{profile.label}</strong>
      <span className="agentnew-model-connection-kind"><Trans>第三方 / OpenAI 兼容</Trans></span></span>
      <span className="agentnew-model-connection-summary-meta"><span>{t`${profile.models.length} 个模型`}</span>
        <span className={profile.credentialConfigured ? 'is-configured' : 'is-missing'}>
          {profile.credentialConfigured ? <Trans>Key 已配置</Trans> : <Trans>Key 未配置</Trans>}</span></span>
    </summary>
    <div className="agentnew-model-connection-body">
      <p className="agentnew-model-connection-notice" role="note"><Trans>兼容连接独立于官方模型适配层，不是官方 DeepSeek 直连；请求只会发送到此连接的地址。</Trans></p>
      <dl className="agentnew-model-connection-details"><div><dt><Trans>协议</Trans></dt><dd><Trans>OpenAI 兼容</Trans></dd></div>
        <div><dt>Base URL</dt><dd><code>{profile.baseUrl}</code></dd></div></dl>
      <p className="agentnew-model-connection-status">{profile.credentialConfigured
        ? <Trans>API Key：已配置（不会显示）</Trans>
        : <Trans>API Key：尚未配置</Trans>}</p>
      <ul className="agentnew-model-connection-models">{profile.models.map((model) => <li key={model.id}>
        <span><code>{model.id}</code>{current?.id === profile.id && current.model === model.id ? <small><Trans>新对话默认</Trans></small> : null}</span>
        <span><button type="button" className="agentnew-settings-button is-small" onClick={() => actions.onUseModel?.(profile, model)}><Trans>用此模型新建对话</Trans></button>
          <button type="button" className="agentnew-settings-button is-small" onClick={() => actions.onSetDefaultModel?.(profile, model)}><Trans>设为新对话默认</Trans></button></span>
      </li>)}</ul>
      <div className="agentnew-model-connection-actions"><button type="button" className="agentnew-settings-button" onClick={() => actions.onEditProfile?.(profile)}><Trans>编辑连接</Trans></button>
        <button type="button" className="agentnew-settings-button is-danger" onClick={() => actions.onDeleteProfile?.(profile)}><Trans>删除</Trans></button></div>
    </div>
  </details>
}

/** Displays saved connections and model-specific conversation actions. */
export function ModelConnectionProfilesPanel({ profiles, current, onNewProfile, ...actions }: ModelConnectionProfilesPanelProps) {
  return <section className="agentnew-model-connections-panel" aria-labelledby="agentnew-model-connections-title">
    <div className="agentnew-model-connections-heading"><div><span><Trans>兼容连接</Trans></span><h2 id="agentnew-model-connections-title"><Trans>第三方模型连接</Trans></h2>
      <p><Trans>每个连接独立保存地址和密钥，再明确选择其中的模型。</Trans></p></div>
      <button type="button" className="agentnew-settings-button is-primary" onClick={onNewProfile}><Trans>新建连接</Trans></button></div>
    {profiles.length ? <div className="agentnew-model-connections-list">{profiles.map((profile) =>
      <ProfileCard key={profile.id} profile={profile} current={current} open={profile.id === current?.id} actions={actions} />)}</div>
      : <p className="agentnew-model-connections-empty"><Trans>还没有第三方模型连接。</Trans></p>}
  </section>
}
