import { useLingui } from '@lingui/react/macro'
import type { ComposerModelOption } from './composerModelOptions'
import './ComposerModelPicker.css'

interface OptionGroup {
  readonly key: string
  readonly matchKey: string
  readonly label: string
  readonly options: readonly ComposerModelOption[]
}

function optionGroups(
  options: readonly ComposerModelOption[],
  builtinLabel: string,
  currentLabel: string,
): readonly OptionGroup[] {
  const groups: OptionGroup[] = []
  for (const option of options) {
    const label = option.group === 'builtin'
      ? builtinLabel
      : option.group === 'current' ? currentLabel : option.groupLabel
    const matchKey = `${option.group}:${option.groupLabel}`
    const previous = groups.at(-1)
    if (previous?.matchKey === matchKey) {
      groups[groups.length - 1] = { ...previous, options: [...previous.options, option] }
    } else {
      groups.push({ key: option.key, matchKey, label, options: [option] })
    }
  }
  return groups
}

export function ComposerModelPicker({
  options,
  value,
  disabled,
  onChange,
}: {
  options: readonly ComposerModelOption[]
  value: string
  disabled: boolean
  onChange: (key: string) => void
}) {
  const { t } = useLingui()
  const groups = optionGroups(options, t`内置模型`, t`当前模型`)
  const selectedLabel = options.find((option) => option.key === value)?.label

  return (
    <label
      className={`agentnew-composer-model-picker ${disabled ? 'is-disabled' : ''}`}
      title={selectedLabel}
    >
      <ModelGlyph />
      <select
        aria-label={t`模型`}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {groups.map((group) => (
          <optgroup key={group.key} label={group.label}>
            {group.options.map((option) => (
              <option key={option.key} value={option.key} title={option.label}>{option.label}</option>
            ))}
          </optgroup>
        ))}
      </select>
      <ChevronGlyph />
    </label>
  )
}

function ModelGlyph() {
  return (
    <svg className="agentnew-composer-model-glyph" viewBox="0 0 16 16" aria-hidden="true">
      <path d="m8 1.75 5.25 3.02v6.06L8 13.85l-5.25-3.02V4.77L8 1.75Z" />
      <path d="m3.1 4.98 4.9 2.8 4.9-2.8M8 7.78v5.66" />
    </svg>
  )
}

function ChevronGlyph() {
  return (
    <svg className="agentnew-composer-model-chevron" viewBox="0 0 12 12" aria-hidden="true">
      <path d="m3.25 4.75 2.75 2.5 2.75-2.5" />
    </svg>
  )
}
