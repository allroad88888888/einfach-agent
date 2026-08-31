import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithStore } from '../../test/renderWithStore'
import type { ComposerModelOption } from './composerModelOptions'
import { ComposerModelPicker } from './ComposerModelPicker'

const OPTIONS: readonly ComposerModelOption[] = [
  {
    key: 'current', label: '已删除的当前模型', group: 'current', groupLabel: 'Current model',
    identity: { vendor: 'custom', model: 'missing' },
  },
  {
    key: 'builtin', label: 'DeepSeek V4 Pro', group: 'builtin', groupLabel: 'Built-in models',
    identity: { vendor: 'deepseek', model: 'deepseek-v4-pro' },
  },
  {
    key: 'profile-a', label: '超长的连接模型名称 / reasoning-model-v2',
    group: 'profile', groupLabel: '团队网关',
    identity: { vendor: 'openai-compat', model: 'reasoning', vendorSettings: { connectionId: 'team' } },
  },
]

describe('ComposerModelPicker', () => {
  it('按当前、内置与 profile 分组，只上报稳定 key', () => {
    const onChange = vi.fn()
    renderWithStore(
      <ComposerModelPicker options={OPTIONS} value="builtin" disabled={false} onChange={onChange} />,
    )

    const picker = screen.getByRole('combobox', { name: '模型' })
    expect(picker).toHaveValue('builtin')
    expect(screen.getByRole('group', { name: '当前模型' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: '内置模型' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: '团队网关' })).toBeInTheDocument()

    fireEvent.change(picker, { target: { value: 'profile-a' } })
    expect(onChange).toHaveBeenCalledWith('profile-a')
  })

  it('长标签保留 title，busy 时不可操作', () => {
    renderWithStore(
      <ComposerModelPicker options={OPTIONS} value="profile-a" disabled onChange={vi.fn()} />,
    )

    expect(screen.getByRole('combobox', { name: '模型' })).toBeDisabled()
    expect(screen.getAllByTitle('超长的连接模型名称 / reasoning-model-v2')).toHaveLength(2)
  })
})
