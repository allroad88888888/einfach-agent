import {
  DEEPSEEK_FLASH_MODEL,
  DEEPSEEK_MODEL_LABELS,
  DEFAULT_DEEPSEEK_MODEL,
  DEFAULT_KIMI_MODEL,
} from '@einfach-agent/ai'
import { useAtomValue } from '@einfach/react'
import { newSession } from '@einfach-agent/core'
import { isKimiImageInputEnabled } from '../../modelInput/kimiImageFeature'
import { closeSettingsCenter } from '../../settings/commands'
import { MODEL_CREDENTIALS } from '../../settings/modelCredentialHost'
import {
  modelCredentialAtoms,
  modelCredentialHostAvailableAtom,
} from '../../settings/state'
import { ModelCredentialCard } from './ModelCredentialCard'

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
  const credentialHostAvailable = useAtomValue(modelCredentialHostAvailableAtom)
  const kimiCredential = useAtomValue(modelCredentialAtoms('kimi-cn').status)
  const kimiEntryVisible = isKimiImageInputEnabled() && credentialHostAvailable
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
          <h3 id="agentnew-model-settings-title">模型</h3>
          <p>文本任务默认使用 DeepSeek；带图片的任务由支持图片的模型处理。</p>
        </div>
      </div>

      <div className="agentnew-model-summary" aria-label="模型分工">
        {/* 展示名一律查 DEEPSEEK_MODEL_LABELS，不写死：写死过一次，默认档换成 Pro 之后
            这里还挂着 "DeepSeek V4 Flash"，同一张卡自相矛盾了很久。 */}
        <div>
          <span>主 Agent 默认</span>
          <code>{DEFAULT_DEEPSEEK_MODEL}</code>
          <small>{DEEPSEEK_MODEL_LABELS[DEFAULT_DEEPSEEK_MODEL]}</small>
        </div>
        {/* 「省钱档」而不是「升级档」：按 subagents/routing.ts，Pro 是兜底档（未知 provider、
            自定义模型、先前失败、最终验收、动过危险工具、跨模块、高风险一律走它），
            Flash 才是要挣来的那一档。主 Agent 也在 Pro 之后，「升级」根本不存在。 */}
        <div>
          <span>子 Agent 省钱档</span>
          <code>{DEEPSEEK_FLASH_MODEL}</code>
          <small>{DEEPSEEK_MODEL_LABELS[DEEPSEEK_FLASH_MODEL]}</small>
        </div>
        {kimiEntryVisible ? (
          <div>
            <span>图片输入</span>
            <code>{DEFAULT_KIMI_MODEL}</code>
            <small>Kimi 中国区</small>
          </div>
        ) : null}
      </div>
      <p className="agentnew-model-routing-note">
        子 Agent 默认与主 Agent 同档；只有低风险的检索、提取类任务才降到 Flash。
        先前失败过、最终验收、动过需确认的工具、跨模块或高风险的任务一律留在 Pro。
      </p>
      {kimiEntryVisible ? (
        <p className="agentnew-model-routing-note">
          图片上传协议、文件引用与清理由 Kimi adapter 负责；桌面原生层只提供受限的通用传输。
        </p>
      ) : null}

      {MODEL_CREDENTIALS.filter((credential) => (
        credential.id !== 'kimi-cn' || kimiEntryVisible
      )).map((credential) => (
        <ModelCredentialCard key={credential.id} credential={credential} />
      ))}

      {kimiEntryVisible ? (
        <div className="agentnew-model-footer">
          <span>
            {kimiCredential.configured
              ? '首期仅开放已核对协议的中国区 Kimi 图片会话。'
              : '请先配置 Kimi 中国区 API Key。'}
          </span>
          <button
            type="button"
            className="agentnew-settings-button is-primary"
            disabled={kimiSessionDisabled}
            onClick={startKimiImageSession}
          >
            新建 Kimi 图片对话
          </button>
        </div>
      ) : null}

      <p className="agentnew-model-help">
        仅桌面应用可保存密钥；静态 Web 部署不会直连模型服务。
      </p>
      <p className="agentnew-model-security-note">
        密钥保存于 ~/.webAgent/config.json；前端不会持久化或读取已保存的值。
      </p>
    </section>
  )
}
