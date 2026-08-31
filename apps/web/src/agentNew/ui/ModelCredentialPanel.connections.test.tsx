import { activeSessionIdAtom, rootStore, sessionsAtom } from '@einfach-agent/core'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithStore } from '../../test/renderWithStore'
import {
  configureAppSettingsStorage,
  configureModelCredentialHost,
  configureModelEndpointHost,
  openSettingsCenter,
  setDefaultModelConnection,
} from '../../settings/commands'
import {
  configureModelConnectionProfileHost,
  hydrateModelConnectionProfiles,
} from '../../settings/modelConnectionProfileCommands'
import {
  createUnavailableModelConnectionProfileHost,
  type ModelConnectionProfile,
  type ModelConnectionProfileHost,
  type ModelConnectionProfileSaveInput,
} from '../../settings/modelConnectionProfileHost'
import { createUnavailableModelCredentialHost } from '../../settings/modelCredentialHost'
import { createUnavailableModelEndpointHost } from '../../settings/modelEndpointHost'
import { resetModelConnectionProfileState } from '../../settings/modelConnectionProfileState'
import { createMemoryAppSettingsStorage } from '../../settings/persistence'
import {
  appSettingsAtom,
  resetAppSettingsState,
  settingsCenterOpenAtom,
} from '../../settings/state'
import { uiStore } from '../../uiStore'
import { ModelCredentialPanel } from './ModelCredentialPanel'

const PROFILE: ModelConnectionProfile = {
  id: 'hosted-deepseek',
  label: '云厂商 DeepSeek',
  kind: 'openai-compatible',
  baseUrl: 'https://gateway.example.com/v1',
  models: [
    { id: 'deepseek-v3', label: 'DeepSeek V3', source: 'manual' },
    { id: 'deepseek-r1', label: 'DeepSeek R1', source: 'manual' },
  ],
  credentialConfigured: true,
}

function availableCredentialHost() {
  return {
    available: true,
    status: async () => ({ configured: false, source: 'missing' as const }),
    save: async () => ({ configured: true, source: 'config' as const }),
    delete: async () => ({ configured: false, source: 'missing' as const }),
  }
}

function availableEndpointHost() {
  return {
    available: true,
    status: async () => ({ configured: false }),
    save: async (baseUrl: string) => ({ configured: true, baseUrl }),
    delete: async () => ({ configured: false }),
  }
}

function profileHost(options: { failDelete?: boolean } = {}): ModelConnectionProfileHost {
  let profiles = [PROFILE]
  return {
    available: true,
    list: async () => profiles,
    read: async (id) => profiles.find((profile) => profile.id === id) ?? null,
    save: async (input: ModelConnectionProfileSaveInput) => {
      const { apiKey: _apiKey, ...publicInput } = input
      const saved = {
        ...publicInput,
        kind: 'openai-compatible' as const,
        credentialConfigured: true,
      }
      profiles = [...profiles.filter((profile) => profile.id !== input.id), saved]
      return saved
    },
    delete: async (id) => {
      if (options.failDelete) throw new Error('删除失败')
      const deleted = profiles.some((profile) => profile.id === id)
      profiles = profiles.filter((profile) => profile.id !== id)
      return { deleted }
    },
    probe: async () => ({ models: [] }),
  }
}

async function configureServerProfiles(host = profileHost()): Promise<void> {
  configureModelCredentialHost(availableCredentialHost())
  configureModelEndpointHost(availableEndpointHost())
  configureModelConnectionProfileHost(host)
  await hydrateModelConnectionProfiles()
}

describe('ModelCredentialPanel connection integration', () => {
  beforeEach(() => {
    resetAppSettingsState(uiStore)
    resetModelConnectionProfileState(uiStore)
    configureAppSettingsStorage(createMemoryAppSettingsStorage())
    vi.stubEnv('VITE_KIMI_IMAGE_INPUT_ENABLED', 'false')
  })

  afterEach(() => {
    configureModelCredentialHost(createUnavailableModelCredentialHost())
    configureModelEndpointHost(createUnavailableModelEndpointHost())
    configureModelConnectionProfileHost(createUnavailableModelConnectionProfileHost())
  })

  it('separates official, legacy, and server profile connection groups', async () => {
    await configureServerProfiles()
    setDefaultModelConnection({ id: PROFILE.id, model: PROFILE.models[0].id })
    renderWithStore(<ModelCredentialPanel />, { store: uiStore })

    const official = screen.getByRole('heading', { name: '官方模型' }).parentElement
    expect(official).not.toBeNull()
    expect(within(official!).getAllByText('官方直连')).toHaveLength(2)
    expect(within(official!).getByText('DeepSeek').closest('details')).toHaveAttribute('open')

    const legacy = screen.getByRole('heading', { name: '兼容连接迁移' }).parentElement
    expect(within(legacy!).getByText('旧版单连接（迁移用）')).toBeInTheDocument()
    expect(legacy).toHaveTextContent('第三方 / OpenAI 兼容')

    expect(screen.getByRole('heading', { name: '第三方模型连接' })).toBeInTheDocument()
    expect(screen.getByText('云厂商 DeepSeek').closest('details')).toHaveAttribute('open')
    expect(screen.getByText(/不是官方 DeepSeek 直连/)).toBeInTheDocument()
  })

  it('sets the future default and creates an ID-only explicit session', async () => {
    await configureServerProfiles()
    const user = userEvent.setup()
    renderWithStore(<ModelCredentialPanel />, { store: uiStore })

    await user.click(screen.getAllByRole('button', { name: '设为新对话默认' })[1])
    expect(uiStore.getter(appSettingsAtom).defaultModelConnection).toEqual({
      id: PROFILE.id,
      model: PROFILE.models[1].id,
    })

    openSettingsCenter()
    await user.click(screen.getAllByRole('button', { name: '用此模型新建对话' })[1])
    const session = rootStore.getter(sessionsAtom)[rootStore.getter(activeSessionIdAtom)]
    expect(session).toMatchObject({
      title: '云厂商 DeepSeek · DeepSeek R1',
      settings: {
        vendor: 'openai-compat',
        model: PROFILE.models[1].id,
        vendorSettings: { connectionId: PROFILE.id },
      },
    })
    expect(JSON.stringify(session?.settings)).not.toContain(PROFILE.baseUrl)
    expect(JSON.stringify(session?.settings)).not.toContain('apiKey')
    expect(uiStore.getter(settingsCenterOpenAtom)).toBe(false)
  })

  it('binds create, cancel, and save to the write-only profile editor', async () => {
    await configureServerProfiles()
    const user = userEvent.setup()
    renderWithStore(<ModelCredentialPanel />, { store: uiStore })

    await user.click(screen.getByRole('button', { name: '新建连接' }))
    expect(screen.getByRole('form', { name: '新建模型连接' })).toBeInTheDocument()
    await user.type(screen.getByLabelText('API Key（写入后不会显示）'), 'discarded-key')
    await user.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('form', { name: '新建模型连接' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '新建连接' }))
    await user.type(screen.getByLabelText('连接 ID'), 'private-gateway')
    await user.type(screen.getByLabelText('名称'), '私有网关')
    await user.type(screen.getByLabelText('Base URL'), 'https://private.example.com/v1')
    await user.type(screen.getByLabelText('手动模型 ID'), 'deepseek-private')
    await user.click(screen.getByRole('button', { name: '添加模型' }))
    await user.type(screen.getByLabelText('API Key（写入后不会显示）'), 'write-only-key')
    await user.click(screen.getByRole('button', { name: '创建连接' }))

    expect(await screen.findByText('私有网关')).toBeInTheDocument()
    expect(screen.queryByDisplayValue('write-only-key')).not.toBeInTheDocument()
  })

  it('clears a deleted default only after the host confirms deletion', async () => {
    await configureServerProfiles()
    setDefaultModelConnection({ id: PROFILE.id, model: PROFILE.models[0].id })
    const user = userEvent.setup()
    renderWithStore(<ModelCredentialPanel />, { store: uiStore })

    await user.click(screen.getByRole('button', { name: '删除' }))
    await waitFor(() => expect(screen.queryByText('云厂商 DeepSeek')).not.toBeInTheDocument())
    expect(uiStore.getter(appSettingsAtom).defaultModelConnection).toBeUndefined()
  })

  it('retains the default when profile deletion fails', async () => {
    await configureServerProfiles(profileHost({ failDelete: true }))
    setDefaultModelConnection({ id: PROFILE.id, model: PROFILE.models[0].id })
    const user = userEvent.setup()
    renderWithStore(<ModelCredentialPanel />, { store: uiStore })

    await user.click(screen.getByRole('button', { name: '删除' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('删除失败')
    expect(uiStore.getter(appSettingsAtom).defaultModelConnection).toEqual({
      id: PROFILE.id,
      model: PROFILE.models[0].id,
    })
  })

  it('synchronizes the selected model after editing its profile', async () => {
    await configureServerProfiles()
    setDefaultModelConnection({ id: PROFILE.id, model: PROFILE.models[0].id })
    const user = userEvent.setup()
    renderWithStore(<ModelCredentialPanel />, { store: uiStore })

    await user.click(screen.getByRole('button', { name: '编辑连接' }))
    await user.click(screen.getByRole('button', { name: '移除模型 deepseek-v3' }))
    await user.click(screen.getByRole('button', { name: '保存编辑' }))

    await waitFor(() => expect(uiStore.getter(appSettingsAtom).defaultModelConnection).toBeUndefined())
  })

  it('hides third-party profile controls for static deployments', () => {
    configureModelCredentialHost(availableCredentialHost())
    configureModelEndpointHost(createUnavailableModelEndpointHost())
    configureModelConnectionProfileHost(createUnavailableModelConnectionProfileHost())
    renderWithStore(<ModelCredentialPanel />, { store: uiStore })

    expect(screen.queryByRole('heading', { name: '第三方模型连接' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '兼容连接迁移' })).not.toBeInTheDocument()
    expect(document.querySelector('.agentnew-model-security-note')).toHaveTextContent('静态部署不提供第三方或自建 OpenAI 兼容连接')
    expect(screen.getByRole('heading', { name: '官方模型' })).toBeInTheDocument()
  })
})
