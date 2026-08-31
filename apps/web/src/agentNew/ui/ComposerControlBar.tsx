import { useId, useMemo } from 'react'
import { useLingui } from '@lingui/react/macro'
import { useAtomValue } from '@einfach/react'
import {
  defaultProviderRegistry,
  getModelThinkingCapability,
  isSupportedThinkingEffort,
} from '@einfach-agent/ai'
import { setActiveSessionModelSettings, type ModelSettings } from '@einfach-agent/core'
import { modelConnectionProfilesAtom } from '../../settings/modelConnectionProfileState'
import {
  composerModelOptions,
  findComposerModelOption,
  type ComposerModelOption,
} from './composerModelOptions'
import {
  selectComposerModelSettings,
  setComposerThinkingEffort,
  setComposerThinkingEnabled,
  type ComposerThinkingEffort,
} from './composerModelSettings'
import { ComposerModelPicker } from './ComposerModelPicker'
import { ComposerThinkingControl } from './ComposerThinkingControl'

function connectionId(settings: Pick<ModelSettings, 'vendorSettings'>): string | undefined {
  const value = settings.vendorSettings?.connectionId
  return typeof value === 'string' ? value : undefined
}

function isCurrentOption(option: ComposerModelOption, settings: ModelSettings): boolean {
  return option.identity.vendor === settings.vendor
    && option.identity.model === settings.model
    && connectionId(option.identity) === connectionId(settings)
}

export function ComposerControlBar({
  approvalMode,
  modelSettings,
  sessionId,
  modelSettingsDisabled,
  queuedMessageCount,
  onToggleApprovalMode,
}: {
  approvalMode: 'confirm' | 'auto'
  modelSettings: ModelSettings
  sessionId?: string
  modelSettingsDisabled: boolean
  queuedMessageCount: number
  onToggleApprovalMode: () => void
}) {
  const { t } = useLingui()
  const fallbackId = useId()
  const profiles = useAtomValue(modelConnectionProfilesAtom)
  const options = useMemo(
    () => composerModelOptions(modelSettings, profiles),
    [modelSettings, profiles],
  )
  const selected = options.find((option) => isCurrentOption(option, modelSettings))
  const capability = getModelThinkingCapability(
    defaultProviderRegistry,
    modelSettings.vendor,
    modelSettings.model,
  )
  const storedEffort = modelSettings.vendorSettings?.reasoning_effort
  const effort: ComposerThinkingEffort = isSupportedThinkingEffort(capability, storedEffort)
    ? storedEffort
    : 'auto'
  const thinkingEnabled = (capability.kind === 'toggle' || capability.kind === 'effort')
    && (modelSettings.thinking ?? capability.defaultEnabled ?? false)
  const approvalModeLabel = approvalMode === 'auto' ? t`Auto` : t`确认`

  const selectModel = (key: string) => {
    const target = findComposerModelOption(options, key)
    if (!target || modelSettingsDisabled) return
    const targetCapability = getModelThinkingCapability(
      defaultProviderRegistry,
      target.identity.vendor,
      target.identity.model,
    )
    setActiveSessionModelSettings(selectComposerModelSettings(
      modelSettings,
      target.identity,
      targetCapability,
    ))
  }

  return (
    <div className="agentnew-composer-status-line">
      <ComposerModelPicker
        options={options}
        value={selected?.key ?? ''}
        disabled={modelSettingsDisabled}
        onChange={selectModel}
      />
      <ComposerThinkingControl
        capability={capability}
        enabled={thinkingEnabled}
        effort={effort}
        disabled={modelSettingsDisabled}
        radioName={`composer-thinking-effort-${sessionId ?? fallbackId}`}
        onToggle={(enabled) => {
          if (modelSettingsDisabled) return
          setActiveSessionModelSettings(setComposerThinkingEnabled(modelSettings, capability, enabled))
        }}
        onEffortChange={(nextEffort) => {
          if (modelSettingsDisabled) return
          setActiveSessionModelSettings(setComposerThinkingEffort(modelSettings, capability, nextEffort))
        }}
      />
      <button
        type="button"
        className={`agentnew-composer-mode ${approvalMode === 'auto' ? 'is-auto' : ''}`}
        aria-label={t`授权模式：${approvalModeLabel}，Shift+Tab 切换`}
        title={t`点击或按 Shift + Tab 切换授权模式`}
        onClick={onToggleApprovalMode}
      >
        {t`授权：${approvalModeLabel}`}
        <span aria-hidden="true">{t` · ⇧Tab 切换`}</span>
      </button>
      {queuedMessageCount > 0 ? (
        <span className="agentnew-composer-queue-status" role="status">
          {t`已排队 ${queuedMessageCount} 条`}
        </span>
      ) : null}
    </div>
  )
}
