import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { configureCommands } from '@web-agent/core/runtime/commands'
import { defaultCore } from '@web-agent/core/runtime/core/coreInstance'
import {
  activeSessionIdAtom,
  rootStore,
  sessionsAtom,
} from '@web-agent/core/state/rootStore'
import { renderWithStore } from '../../test/renderWithStore'
import { configureMcpSettings } from '../../mcp/commands'
import { createMemoryMcpConfigStorage } from '../../mcp/persistence'
import { resetMcpSettingsState } from '../../mcp/state'
import {
  configureAppSettingsStorage,
  configureModelCredentialHost,
} from '../../settings/commands'
import type {
  ModelCredentialHost,
  ModelCredentialTarget,
} from '../../settings/modelCredentialHost'
import { createUnavailableModelCredentialHost } from '../../settings/modelCredentialHost'
import { createMemoryAppSettingsStorage } from '../../settings/persistence'
import { resetAppSettingsState } from '../../settings/state'
import { SettingsCenter } from './SettingsCenter'
import { UiMcpManager } from './settingsCenterTestFixtures'

HTMLDialogElement.prototype.showModal = vi.fn(function showModal(this: HTMLDialogElement) {
  this.setAttribute('open', '')
})
HTMLDialogElement.prototype.close = vi.fn(function close(this: HTMLDialogElement) {
  this.removeAttribute('open')
  this.dispatchEvent(new Event('close'))
})

function credentialKey(target: ModelCredentialTarget): string {
  return `${target.provider}:${target.scope}`
}

function credentialHost(kimiKey = '', failKimiStatus = false): {
  host: ModelCredentialHost
  saved: (target: ModelCredentialTarget) => string
} {
  const saved = new Map<string, string>()
  if (kimiKey) saved.set('kimi:cn', kimiKey)
  const status = async (target: ModelCredentialTarget) => {
    if (failKimiStatus && target.provider === 'kimi') {
      throw new Error('Kimi 凭证状态读取失败')
    }
    return {
      configured: saved.has(credentialKey(target)),
      source: saved.has(credentialKey(target)) ? 'config' as const : 'missing' as const,
    }
  }
  return {
    host: {
      available: true,
      status: async (target) => status(target),
      save: async (target, key) => {
        saved.set(credentialKey(target), key)
        return status(target)
      },
      delete: async (target) => {
        saved.delete(credentialKey(target))
        return status(target)
      },
    },
    saved: (target) => saved.get(credentialKey(target)) ?? '',
  }
}

describe('SettingsCenter', () => {
  beforeEach(() => {
    resetMcpSettingsState(rootStore)
    resetAppSettingsState(rootStore)
    configureCommands({ customInstructions: '', deepseekApiKey: 'desktop-managed-credential' })
    configureAppSettingsStorage(createMemoryAppSettingsStorage())
    configureMcpSettings({ manager: new UiMcpManager(), storage: createMemoryMcpConfigStorage() })
  })

  afterEach(() => {
    resetMcpSettingsState(rootStore)
    resetAppSettingsState(rootStore)
    configureModelCredentialHost(createUnavailableModelCredentialHost())
  })

  it('traps dialog focus and exposes the settings tabs', async () => {
    const user = userEvent.setup()
    renderWithStore(<SettingsCenter />, { store: rootStore })
    const launchButton = screen.getByRole('button', { name: '打开设置' })
    await user.click(launchButton)

    const dialog = await screen.findByRole('dialog')
    const closeButton = screen.getByRole('button', { name: '关闭设置' })
    expect(closeButton).toHaveFocus()
    await user.click(screen.getByRole('button', { name: '通用' }))
    expect(screen.getByText('暂未开放')).toBeInTheDocument()
    fireEvent(dialog, new Event('cancel', { cancelable: true }))
    expect(launchButton).toHaveFocus()
  })

  it('sends credentials to the host without persisting them in settings or runtime config', async () => {
    const user = userEvent.setup()
    const fake = credentialHost()
    configureModelCredentialHost(fake.host)
    vi.stubEnv('VITE_KIMI_IMAGE_INPUT_ENABLED', 'true')
    const storage = createMemoryAppSettingsStorage()
    configureAppSettingsStorage(storage)
    renderWithStore(<SettingsCenter />, { store: rootStore })
    await user.click(screen.getByRole('button', { name: '打开设置' }))
    await user.click(screen.getByRole('button', { name: '模型' }))

    const input = await screen.findByLabelText('DeepSeek API Key')
    await user.type(input, 'deepseek-test-key')
    await user.click(screen.getByRole('button', { name: '保存 DeepSeek 到应用配置' }))

    await waitFor(() => expect(fake.saved({
      provider: 'deepseek', scope: 'default',
    })).toBe('deepseek-test-key'))
    expect(input).toHaveValue('')

    const kimiInput = screen.getByLabelText('Kimi 中国区 API Key')
    await user.type(kimiInput, 'kimi-test-key')
    await user.click(screen.getByRole('button', { name: '保存 Kimi 中国区 到应用配置' }))
    await waitFor(() => expect(fake.saved({
      provider: 'kimi', scope: 'cn',
    })).toBe('kimi-test-key'))
    expect(kimiInput).toHaveValue('')

    expect(JSON.stringify(storage.load())).not.toContain('deepseek-test-key')
    expect(JSON.stringify(storage.load())).not.toContain('kimi-test-key')
    expect(defaultCore.config.deepseekApiKey).toBe('desktop-managed-credential')
  })

  it('keeps the Kimi image entry closed when the feature gate is off', async () => {
    const user = userEvent.setup()
    configureModelCredentialHost(credentialHost('kimi-test-key').host)
    vi.stubEnv('VITE_KIMI_IMAGE_INPUT_ENABLED', 'false')
    renderWithStore(<SettingsCenter />, { store: rootStore })
    await user.click(screen.getByRole('button', { name: '打开设置' }))
    await user.click(screen.getByRole('button', { name: '模型' }))

    expect(screen.queryByLabelText('Kimi 中国区 API Key')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '新建 Kimi 图片对话' })).not.toBeInTheDocument()
  })

  it('disables the Kimi image entry until its credential is configured', async () => {
    const user = userEvent.setup()
    configureModelCredentialHost(credentialHost().host)
    vi.stubEnv('VITE_KIMI_IMAGE_INPUT_ENABLED', 'true')
    renderWithStore(<SettingsCenter />, { store: rootStore })
    await user.click(screen.getByRole('button', { name: '打开设置' }))
    await user.click(screen.getByRole('button', { name: '模型' }))

    expect(await screen.findByText('请先配置 Kimi 中国区 API Key。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '新建 Kimi 图片对话' })).toBeDisabled()
  })

  it('does not expose the Kimi image entry for an unavailable static Web host', async () => {
    const user = userEvent.setup()
    configureModelCredentialHost(createUnavailableModelCredentialHost())
    vi.stubEnv('VITE_KIMI_IMAGE_INPUT_ENABLED', 'true')
    renderWithStore(<SettingsCenter />, { store: rootStore })
    await user.click(screen.getByRole('button', { name: '打开设置' }))
    await user.click(screen.getByRole('button', { name: '模型' }))

    expect(screen.queryByLabelText('Kimi 中国区 API Key')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '新建 Kimi 图片对话' })).not.toBeInTheDocument()
  })

  it('keeps the Kimi image entry disabled when credential hydration fails', async () => {
    const user = userEvent.setup()
    configureModelCredentialHost(credentialHost('', true).host)
    vi.stubEnv('VITE_KIMI_IMAGE_INPUT_ENABLED', 'true')
    renderWithStore(<SettingsCenter />, { store: rootStore })
    await user.click(screen.getByRole('button', { name: '打开设置' }))
    await user.click(screen.getByRole('button', { name: '模型' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Kimi 凭证状态读取失败')
    expect(screen.getByRole('button', { name: '新建 Kimi 图片对话' })).toBeDisabled()
  })

  it('creates an explicit Kimi image session when the gate and credential are ready', async () => {
    const user = userEvent.setup()
    configureModelCredentialHost(credentialHost('kimi-test-key').host)
    vi.stubEnv('VITE_KIMI_IMAGE_INPUT_ENABLED', 'true')
    renderWithStore(<SettingsCenter />, { store: rootStore })
    await user.click(screen.getByRole('button', { name: '打开设置' }))
    await user.click(screen.getByRole('button', { name: '模型' }))
    const createButton = screen.getByRole('button', { name: '新建 Kimi 图片对话' })
    await waitFor(() => expect(createButton).toBeEnabled())
    await user.click(createButton)

    const id = rootStore.getter(activeSessionIdAtom)
    expect(rootStore.getter(sessionsAtom)[id]).toMatchObject({
      title: 'Kimi 图片对话',
      settings: {
        vendor: 'kimi',
        model: 'kimi-k2.6',
        region: 'cn',
      },
    })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
