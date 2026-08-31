import { useLingui } from '@lingui/react/macro'
import {
  modelSupportsThinking,
  thinkingEfforts,
  type ModelThinkingCapability,
} from '@einfach-agent/ai'
import type { ComposerThinkingEffort } from './composerModelSettings'
import './ComposerThinkingControl.css'

const EFFORT_LABELS: Readonly<Record<ComposerThinkingEffort, string>> = {
  auto: 'Auto', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'XHigh', max: 'Max',
}

export function ComposerThinkingControl({
  capability,
  enabled,
  effort,
  disabled,
  radioName,
  onToggle,
  onEffortChange,
}: {
  capability: ModelThinkingCapability
  enabled: boolean
  effort: ComposerThinkingEffort
  disabled: boolean
  radioName: string
  onToggle: (enabled: boolean) => void
  onEffortChange: (effort: ComposerThinkingEffort) => void
}) {
  const { t } = useLingui()
  const supported = modelSupportsThinking(capability)
  const unavailableReason = capability.kind === 'unknown'
    ? t`当前模型的 Thinking 能力未知`
    : t`当前模型不支持 Thinking`
  const options: readonly ComposerThinkingEffort[] = capability.kind === 'effort'
    ? ['auto', ...thinkingEfforts(capability)]
    : []
  const toggleDisabled = disabled || !supported

  return (
    <div
      className={`agentnew-composer-thinking-control ${enabled && supported ? 'is-enabled' : ''}`}
      role="group"
      aria-label={t`Thinking 设置`}
    >
      <button
        type="button"
        className="agentnew-composer-thinking-toggle"
        aria-pressed={supported ? enabled : false}
        aria-label={!supported
          ? unavailableReason
          : enabled ? t`Thinking 已开启，点击关闭` : t`Thinking 已关闭，点击开启`}
        title={!supported ? unavailableReason : undefined}
        disabled={toggleDisabled}
        onClick={() => onToggle(!enabled)}
      >
        <ThinkingGlyph />
        <span>Thinking</span>
        <span className="agentnew-composer-thinking-toggle-state" aria-hidden="true">
          {!supported ? 'N/A' : enabled ? 'On' : 'Off'}
        </span>
      </button>
      {options.length > 0 ? (
        <div className="agentnew-composer-thinking-options">
          {options.map((option) => (
            <label
              key={option}
              className={`agentnew-composer-thinking-option is-${option}`}
              title={option === 'auto' ? t`使用模型默认档位` : EFFORT_LABELS[option]}
            >
              <input
                type="radio"
                name={radioName}
                value={option}
                checked={effort === option}
                disabled={disabled || !enabled}
                aria-label={option === 'auto'
                  ? `${EFFORT_LABELS[option]}：${t`使用模型默认档位`}`
                  : EFFORT_LABELS[option]}
                onChange={() => onEffortChange(option)}
              />
              <span>{EFFORT_LABELS[option]}</span>
            </label>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function ThinkingGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 1.75 9.1 5.4 12.75 6.5 9.1 7.6 8 11.25 6.9 7.6 3.25 6.5 6.9 5.4 8 1.75Z" />
      <path d="m12.15 10.1.55 1.8 1.8.55-1.8.55-.55 1.8-.55-1.8-1.8-.55 1.8-.55.55-1.8Z" />
    </svg>
  )
}
