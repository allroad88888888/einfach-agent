import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { configureCommands } from '@web-agent/core/runtime/commands'
import { defaultCore } from '@web-agent/core/runtime/core/coreInstance'
import { rootStore } from '@web-agent/core/state/rootStore'
import { renderWithStore } from '../../test/renderWithStore'
import { configureMcpSettings } from '../../mcp/commands'
import { createMemoryMcpConfigStorage } from '../../mcp/persistence'
import { resetMcpSettingsState } from '../../mcp/state'
import {
  configureAppSettingsStorage,
  configureModelCredentialHost,
} from '../../settings/commands'
import type { ModelCredentialHost } from '../../settings/modelCredentialHost'
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

function credentialHost(): { host: ModelCredentialHost; saved: () => string } {
  let saved = ''
  const status = () => ({ configured: Boolean(saved), source: saved ? 'keychain' as const : 'missing' as const })
  return {
    host: {
      deepSeekStatus: async () => status(),
      saveDeepSeek: async (key) => {
        saved = key
        return status()
      },
      deleteDeepSeek: async () => {
        saved = ''
        return status()
      },
    },
    saved: () => saved,
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
    const storage = createMemoryAppSettingsStorage()
    configureAppSettingsStorage(storage)
    renderWithStore(<SettingsCenter />, { store: rootStore })
    await user.click(screen.getByRole('button', { name: '打开设置' }))
    await user.click(screen.getByRole('button', { name: '模型' }))

    const input = await screen.findByLabelText('DeepSeek API Key')
    await user.type(input, 'deepseek-test-key')
    await user.click(screen.getByRole('button', { name: '保存到系统钥匙串' }))

    await waitFor(() => expect(fake.saved()).toBe('deepseek-test-key'))
    expect(input).toHaveValue('')
    expect(JSON.stringify(storage.load())).not.toContain('deepseek-test-key')
    expect(defaultCore.config.deepseekApiKey).toBe('desktop-managed-credential')
  })
})
