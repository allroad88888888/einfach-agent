import { fireEvent, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { defaultProviderRegistry, getModelThinkingCapability } from '@einfach-agent/ai'
import { activateLocale } from '../../i18n'
import { renderWithStore } from '../../test/renderWithStore'
import { ComposerThinkingControl } from './ComposerThinkingControl'

const REQUIRED_CAPABILITY = {
  kind: 'effort',
  sourceUrl: 'https://example.test/required-thinking',
  efforts: ['low', 'high', 'max'],
  required: true,
} as const

function capability(vendor: string, model: string) {
  return getModelThinkingCapability(defaultProviderRegistry, vendor, model)
}

function renderControl(overrides: Partial<Parameters<typeof ComposerThinkingControl>[0]> = {}) {
  const props: Parameters<typeof ComposerThinkingControl>[0] = {
    capability: capability('deepseek', 'deepseek-v4-pro'),
    enabled: true,
    effort: 'high',
    disabled: false,
    radioName: 'session-a',
    onToggle: vi.fn(),
    onEffortChange: vi.fn(),
    ...overrides,
  }
  return { props, ...renderWithStore(<ComposerThinkingControl {...props} />) }
}

describe('ComposerThinkingControl', () => {
  it('DeepSeek 只显示 Auto/Low/High/Max，并把操作交给外部状态', () => {
    const { props } = renderControl()

    const toggle = screen.getByRole('button', { name: 'Thinking 已开启，点击关闭' })
    const high = screen.getByRole('radio', { name: /High/ })
    expect(screen.getAllByRole('radio').map((radio) => radio.getAttribute('value'))).toEqual([
      'auto', 'low', 'high', 'max',
    ])
    expect(high).toBeChecked()
    fireEvent.click(toggle)
    expect(props.onToggle).toHaveBeenCalledWith(false)
    fireEvent.click(screen.getByRole('radio', { name: 'Max' }))
    expect(props.onEffortChange).toHaveBeenCalledWith('max')
  })

  it('GLM-5.3 始终开启 Thinking 并显示全部受审档位', () => {
    const { props } = renderControl({
      capability: capability('glm', 'glm-5.3'), enabled: false, effort: 'high',
    })

    const toggle = screen.getByRole('button', { name: 'Thinking 始终开启' })
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(toggle).toBeDisabled()
    expect(screen.getAllByRole('radio').map((radio) => radio.getAttribute('value'))).toEqual([
      'auto', 'low', 'high', 'max',
    ])
    expect(screen.getByRole('radio', { name: 'High' })).toBeChecked()
    expect(screen.getAllByRole('radio').every((radio) => !radio.hasAttribute('disabled'))).toBe(true)
    fireEvent.click(toggle)
    expect(props.onToggle).not.toHaveBeenCalled()
  })

  it('unknown capability gives an unavailable explanation', () => {
    renderControl({ capability: capability('custom', 'unknown') })
    expect(screen.getByRole('button', { name: '当前模型的 Thinking 能力未知' })).toBeDisabled()
  })

  it('busy 时禁用全部操作，两个会话的 radio name 不冲突', () => {
    renderWithStore(<>
      <ComposerThinkingControl
        capability={capability('deepseek', 'deepseek-v4-pro')}
        enabled effort="high" disabled radioName="session-a"
        onToggle={vi.fn()} onEffortChange={vi.fn()}
      />
      <ComposerThinkingControl
        capability={capability('deepseek', 'deepseek-v4-pro')}
        enabled effort="max" disabled={false} radioName="session-b"
        onToggle={vi.fn()} onEffortChange={vi.fn()}
      />
    </>)

    const groups = screen.getAllByRole('group', { name: 'Thinking 设置' })
    expect(within(groups[0]).getByRole('button')).toBeDisabled()
    expect(within(groups[0]).getAllByRole('radio').every((radio) => radio.hasAttribute('disabled'))).toBe(true)
    expect(within(groups[0]).getByRole('radio', { name: /High/ })).toHaveAttribute('name', 'session-a')
    expect(within(groups[1]).getByRole('radio', { name: /Max/ })).toHaveAttribute('name', 'session-b')
  })

  it('required capability 始终显示 On、不能关闭但仍可选择档位', () => {
    const { props } = renderControl({
      capability: REQUIRED_CAPABILITY,
      enabled: false,
      effort: 'low',
    })

    const toggle = screen.getByRole('button', { name: 'Thinking 始终开启' })
    expect(toggle).toBeDisabled()
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(toggle).toHaveAttribute('title', 'Thinking 始终开启')
    expect(toggle).toHaveTextContent('On')
    expect(screen.getAllByRole('radio').map((radio) => radio.getAttribute('value'))).toEqual([
      'auto', 'low', 'high', 'max',
    ])
    expect(screen.getByRole('radio', { name: 'Low' })).toBeEnabled()
    fireEvent.click(screen.getByRole('radio', { name: 'Max' }))
    expect(props.onEffortChange).toHaveBeenCalledWith('max')
    expect(props.onToggle).not.toHaveBeenCalled()
  })

  it('translates the required toggle accessible name and title in English', async () => {
    await activateLocale('en')
    const { props } = renderControl({ capability: REQUIRED_CAPABILITY, enabled: false, effort: 'low' })

    const toggle = screen.getByRole('button', { name: 'Thinking is always on' })
    expect(toggle).toHaveAttribute('title', 'Thinking is always on')
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    expect(props.onToggle).not.toHaveBeenCalled()

    await activateLocale('zh-CN')
  })
})
