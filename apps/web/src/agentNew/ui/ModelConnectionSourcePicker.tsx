import type { ModelConnectionPreset } from '../../settings/modelConnectionPresetRegistry'
import { Trans, useLingui } from '@lingui/react/macro'

export interface ModelConnectionSourcePickerProps {
  presets: readonly ModelConnectionPreset[]
  onSelect: (preset: ModelConnectionPreset) => void
  onImport: (file: File) => void
}

/** Selects a safe public starting point for a connection draft. */
export function ModelConnectionSourcePicker({ presets, onSelect, onImport }: ModelConnectionSourcePickerProps) {
  const { t } = useLingui()
  const categoryLabels = {
    cloud: t`云端服务商`,
    'self-hosted': t`自部署`,
    local: t`本地`,
  } as const
  return (
    <fieldset className="agentnew-model-source-picker">
      <legend><Trans>从预设开始</Trans></legend>
      <p><Trans>预设只会填入公开地址和名称；密钥始终由你在下方单独填写。</Trans></p>
      {(Object.keys(categoryLabels) as Array<keyof typeof categoryLabels>).map((category) => (
        <div key={category}>
          <span>{categoryLabels[category]}</span>
          <div>{presets.filter((preset) => preset.category === category).map((preset) => (
            <button key={preset.id} type="button" className="agentnew-settings-button is-small" onClick={() => onSelect(preset)}>{preset.label}</button>
          ))}</div>
        </div>
      ))}
      <label className="agentnew-model-manifest-import"><span><Trans>导入 JSON</Trans></span>
        <input type="file" accept="application/json,.json" onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) onImport(file)
          event.target.value = ''
        }} />
      </label>
      <small><Trans>导入文件不能包含 API Key；导入后仍需填写连接 ID 和 Key 并保存。</Trans></small>
    </fieldset>
  )
}
