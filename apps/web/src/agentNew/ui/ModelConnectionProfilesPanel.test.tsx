import { describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithStore } from '../../test/renderWithStore'
import type { ModelConnectionProfile } from '../../settings/modelConnectionProfileHost'
import { ModelConnectionProfilesPanel } from './ModelConnectionProfilesPanel'

const profiles: ModelConnectionProfile[] = [
  {
    id: 'hosted-deepseek',
    label: '团队 DeepSeek',
    kind: 'openai-compatible',
    baseUrl: 'https://gateway.example/v1',
    models: [{ id: 'deepseek-chat', label: 'DeepSeek Chat', source: 'manual' }],
    credentialConfigured: true,
  },
  {
    id: 'local-gateway',
    label: '本地网关',
    kind: 'openai-compatible',
    baseUrl: 'http://localhost:8000/v1',
    models: [{ id: 'my-model', label: 'My Model', source: 'manual' }],
    credentialConfigured: false,
  },
]

describe('ModelConnectionProfilesPanel', () => {
  it('uses disclosure semantics and expands the current profile by default', () => {
    renderWithStore(<ModelConnectionProfilesPanel profiles={profiles} current={{ id: 'local-gateway', model: 'my-model' }} />)

    expect(screen.getByRole('heading', { name: '第三方模型连接' })).toBeInTheDocument()
    expect(screen.getAllByText('第三方 / OpenAI 兼容')).toHaveLength(2)
    expect(screen.getByText('Key 已配置')).toBeInTheDocument()
    expect(screen.getByText('Key 未配置')).toBeInTheDocument()
    expect(screen.getByText('API Key：尚未配置')).toBeVisible()
    expect(screen.getByText('API Key：已配置（不会显示）')).not.toBeVisible()
  })

  it('exposes all profile actions and keeps profile values read-only', async () => {
    const user = userEvent.setup()
    const onNewProfile = vi.fn()
    const onEditProfile = vi.fn()
    const onDeleteProfile = vi.fn()
    const onUseProfile = vi.fn()
    const onSetDefaultProfile = vi.fn()
    renderWithStore(
      <ModelConnectionProfilesPanel
        profiles={profiles}
        current={{ id: 'hosted-deepseek', model: 'deepseek-chat' }}
        onNewProfile={onNewProfile}
        onEditProfile={onEditProfile}
        onDeleteProfile={onDeleteProfile}
        onUseModel={onUseProfile}
        onSetDefaultModel={onSetDefaultProfile}
      />,
    )

    await user.click(screen.getByRole('button', { name: '新建连接' }))
    const card = screen.getByText('团队 DeepSeek').closest('details')
    if (!card) throw new Error('expected profile disclosure')
    const cardView = within(card)
    await user.click(cardView.getByRole('button', { name: '编辑连接' }))
    await user.click(cardView.getByRole('button', { name: '用此模型新建对话' }))
    await user.click(cardView.getByRole('button', { name: '设为新对话默认' }))
    await user.click(cardView.getByRole('button', { name: '删除' }))

    expect(onNewProfile).toHaveBeenCalledOnce()
    expect(onEditProfile).toHaveBeenCalledWith(profiles[0])
    expect(onUseProfile).toHaveBeenCalledWith(profiles[0], profiles[0].models[0])
    expect(onSetDefaultProfile).toHaveBeenCalledWith(profiles[0], profiles[0].models[0])
    expect(onDeleteProfile).toHaveBeenCalledWith(profiles[0])
    expect(card.querySelectorAll('input')).toHaveLength(0)
    expect(cardView.getByText(profiles[0].baseUrl)).toBeInTheDocument()
    expect(cardView.getByText(profiles[0].models[0].id)).toBeInTheDocument()
  })
})
