import type { ConnectionProfileModel } from '../../settings/modelConnectionProfileHost'
import { Trans, useLingui } from '@lingui/react/macro'

export interface ModelConnectionModelPickerProps {
  selected: readonly ConnectionProfileModel[]
  discovered: readonly ConnectionProfileModel[]
  probeError?: string
  onAdd: (id: string) => void
  onRemove: (id: string) => void
}

/** Manages explicit model selection from probe results or manual IDs. */
export function ModelConnectionModelPicker({ selected, discovered, probeError, onAdd, onRemove }: ModelConnectionModelPickerProps) {
  const { t } = useLingui()
  const selectedIds = new Set(selected.map((model) => model.id))
  return (
    <section className="agentnew-model-picker" aria-labelledby="agentnew-model-picker-title">
      <h3 id="agentnew-model-picker-title"><Trans>模型</Trans></h3>
      {discovered.length > 0 ? <fieldset><legend><Trans>发现的模型</Trans></legend>{discovered.map((model) => (
        <label key={model.id}><input className="agentnew-settings-checkbox" type="checkbox" checked={selectedIds.has(model.id)}
          onChange={(event) => event.target.checked ? onAdd(model.id) : onRemove(model.id)} />{model.label}</label>
      ))}</fieldset> : <p><Trans>测试连接后可从发现结果中选择模型，也可直接填写模型 ID。</Trans></p>}
      {probeError ? <p role="alert">{probeError}</p> : null}
      <div className="agentnew-model-manual-add">
        <label htmlFor="agentnew-model-manual-id"><Trans>手动模型 ID</Trans></label>
        <input id="agentnew-model-manual-id" className="agentnew-settings-input" placeholder={t`例如：deepseek-chat`} onKeyDown={(event) => {
          if (event.key !== 'Enter') return
          event.preventDefault(); onAdd(event.currentTarget.value); event.currentTarget.value = ''
        }} />
        <button type="button" onClick={(event) => {
          const input = event.currentTarget.previousElementSibling as HTMLInputElement
          onAdd(input.value); input.value = ''
        }} className="agentnew-settings-button"><Trans>添加模型</Trans></button>
      </div>
      <ul>{selected.map((model) => <li key={model.id}><span><code>{model.id}</code><small>{model.source === 'discovered' ? <Trans>已发现</Trans> : <Trans>手动添加</Trans>}</small></span>
        <button type="button" className="agentnew-settings-button is-small" aria-label={t`移除模型 ${model.id}`} onClick={() => onRemove(model.id)}><Trans>移除</Trans></button>
      </li>)}</ul>
    </section>
  )
}
