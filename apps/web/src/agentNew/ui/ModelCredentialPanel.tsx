import {
  DEEPSEEK_FLASH_MODEL,
  DEEPSEEK_MODEL_LABELS,
  DEFAULT_DEEPSEEK_MODEL,
  DEFAULT_KIMI_MODEL,
} from '@einfach-agent/ai'
import { useAtomValue } from '@einfach/react'
import { newSession } from '@einfach-agent/core'
import { Trans, useLingui } from '@lingui/react/macro'
import { isKimiImageInputEnabled } from '../../modelInput/kimiImageFeature'
import { closeSettingsCenter } from '../../settings/commands'
import {
  modelCredentialAtoms,
  modelCredentialHostAvailableAtom,
  modelEndpointHostAvailableAtom,
} from '../../settings/state'
import { modelConnectionProfileHostAvailableAtom } from '../../settings/modelConnectionProfileState'
import { ModelConnectionProfileSettings } from './ModelConnectionProfileSettings'
import { ModelCredentialGroups } from './ModelCredentialGroups'

function startKimiImageSession(): void {
  newSession({
    title: 'Kimi 图片对话',
    settings: {
      vendor: 'kimi',
      model: DEFAULT_KIMI_MODEL,
      // 区域是 Kimi 独有的设置，走供应商附加设置袋；core 只搬运不解释。
      vendorSettings: { region: 'cn' },
    },
  })
  closeSettingsCenter()
}

/** Describes model routing and hosts provider-scoped credential controls. */
export function ModelCredentialPanel() {
  const { t } = useLingui()
  const credentialHostAvailable = useAtomValue(modelCredentialHostAvailableAtom)
  const endpointHostAvailable = useAtomValue(modelEndpointHostAvailableAtom)
  const profileHostAvailable = useAtomValue(modelConnectionProfileHostAvailableAtom)
  const kimiCredential = useAtomValue(modelCredentialAtoms('kimi-cn').status)
  const kimiEntryVisible = isKimiImageInputEnabled() && credentialHostAvailable
  const staticByok = credentialHostAvailable && !endpointHostAvailable
  const kimiCredentialLoading = kimiCredential.status === 'idle'
    || kimiCredential.status === 'loading'
  const kimiSessionDisabled = kimiCredentialLoading || !kimiCredential.configured

  return (
    <section
      className="agentnew-settings-panel agentnew-model-panel"
      aria-labelledby="agentnew-model-settings-title"
    >
      <div className="agentnew-settings-panel-head">
        <div>
          <h3 id="agentnew-model-settings-title"><Trans>模型</Trans></h3>
          <p><Trans>文本任务默认使用 <code>DeepSeek</code>；带图片的任务由支持图片的模型处理。</Trans></p>
        </div>
      </div>

      <div className="agentnew-model-summary" aria-label={t`模型分工`}>
        {/* 展示名一律查 DEEPSEEK_MODEL_LABELS，不写死：写死过一次，默认档换成 Pro 之后
            这里还挂着 "DeepSeek V4 Flash"，同一张卡自相矛盾了很久。 */}
        <div>
          <span><Trans>主 Agent 默认</Trans></span>
          <code>{DEFAULT_DEEPSEEK_MODEL}</code>
          <small>{DEEPSEEK_MODEL_LABELS[DEFAULT_DEEPSEEK_MODEL]}</small>
        </div>
        {/* 「省钱档」而不是「升级档」：按 subagents/routing.ts，Pro 是兜底档（未知 provider、
            自定义模型、先前失败、最终验收、动过危险工具、跨模块、高风险一律走它），
            Flash 才是要挣来的那一档。主 Agent 也在 Pro 之后，「升级」根本不存在。 */}
        <div>
          <span><Trans>子 Agent 省钱档</Trans></span>
          <code>{DEEPSEEK_FLASH_MODEL}</code>
          <small>{DEEPSEEK_MODEL_LABELS[DEEPSEEK_FLASH_MODEL]}</small>
        </div>
        {kimiEntryVisible ? (
          <div>
            <span><Trans>图片输入</Trans></span>
            <code>{DEFAULT_KIMI_MODEL}</code>
            <small><Trans>Kimi 中国区</Trans></small>
          </div>
        ) : null}
      </div>
      <p className="agentnew-model-routing-note">
        <Trans>子 Agent 默认与主 Agent 同档；只有低风险的检索、提取类任务才降到 <code>Flash</code>。
        先前失败过、最终验收、动过需确认的工具、跨模块或高风险的任务一律留在 <code>Pro</code>。</Trans>
      </p>
      {kimiEntryVisible ? (
        <p className="agentnew-model-routing-note">
          <Trans>图片上传协议、文件引用与清理由 <code>Kimi</code> adapter 负责；静态部署会从浏览器直连 <code>Kimi</code>。</Trans>
        </p>
      ) : null}

      <ModelCredentialGroups
        kimiVisible={kimiEntryVisible}
        legacyVisible={endpointHostAvailable}
      />

      {profileHostAvailable ? (
        <ModelConnectionProfileSettings />
      ) : (
        <p className="agentnew-model-security-note">
          <Trans>静态部署不提供第三方或自建 <code>OpenAI</code> 兼容连接：端点与密钥必须由本机后端按连接隔离保存。
          官方模型仍可使用上方的浏览器 <code>BYOK</code>。</Trans>
        </p>
      )}

      {kimiEntryVisible ? (
        <div className="agentnew-model-footer">
          <span>
            {kimiCredential.configured
              ? <Trans>首期仅开放已核对协议的中国区 <code>Kimi</code> 图片会话。</Trans>
              : t`请先配置 Kimi 中国区 API Key。`}
          </span>
          <button
            type="button"
            className="agentnew-settings-button is-primary"
            disabled={kimiSessionDisabled}
            onClick={startKimiImageSession}
          >
            <Trans>新建 <code>Kimi</code> 图片对话</Trans>
          </button>
        </div>
      ) : null}

      {staticByok ? (
        <>
          <p className="agentnew-model-help">
            <Trans>纯静态部署会从浏览器直连 <code>DeepSeek</code>、<code>GLM</code> 或 <code>Kimi</code>。上游服务必须允许当前部署域名的 <code>CORS</code> 请求。</Trans>
          </p>
          <p className="agentnew-model-security-note">
            <Trans>这是 <code>BYOK</code>：<code>Key</code> 以明文保存在此浏览器的 <code>localStorage</code>。任何能在本页面执行的脚本或受信任的浏览器扩展都可能读取它；仅在可信部署中使用，清除网站数据即可删除。</Trans>
          </p>
        </>
      ) : (
        <>
          <p className="agentnew-model-help">
            <Trans>密钥由本机后端保存（<code>pnpm serve</code> 或已安装的本地服务）。</Trans>
          </p>
          <p className="agentnew-model-security-note">
            <Trans>密钥保存于 <code>~/.webAgent/config.json</code>；前端不会持久化或读取已保存的值。</Trans>
          </p>
        </>
      )}
    </section>
  )
}
