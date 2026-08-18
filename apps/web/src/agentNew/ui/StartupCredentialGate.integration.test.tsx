import { uiStore } from '../../uiStore'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { rootStore } from '@web-agent/core'
import { renderWithStore } from '../../test/renderWithStore'
import { configureModelCredentialHost, hydrateModelCredentials } from '../../settings/commands'
import type {
  ModelCredentialHost,
  ModelCredentialTarget,
} from '../../settings/modelCredentialHost'
import { createUnavailableModelCredentialHost } from '../../settings/modelCredentialHost'
import { resetAppSettingsState } from '../../settings/state'
import { StartupCredentialGate } from './StartupCredentialGate'

const target = { ok: true, id: 'deepseek-default' } as const

function targetKey(value: ModelCredentialTarget): string {
  return `${value.provider}:${value.scope}`
}

function createHost(options: { statusError?: boolean } = {}):
  ModelCredentialHost & { configured: boolean; statusError: boolean } {
  const host = {
    available: true,
    configured: false,
    statusError: options.statusError ?? false,
    status: vi.fn(async (value: ModelCredentialTarget) => {
      if (host.statusError) throw new Error('secret-key-from-ipc')
      const configured = host.configured && targetKey(value) === 'deepseek:default'
      return { configured, source: configured ? 'config' as const : 'missing' as const }
    }),
    save: vi.fn(async () => ({ configured: true, source: 'config' as const })),
    delete: vi.fn(async () => ({ configured: false, source: 'missing' as const })),
  }
  return host
}

function renderGate() {
  return renderWithStore(
    <StartupCredentialGate enabled target={target}>
      <p>workspace</p>
    </StartupCredentialGate>,
    // 应用层命令（hydrateModelCredentials…）写的是模块级单例 uiStore，渲染必须绑同一个。
    { store: uiStore },
  )
}

describe('StartupCredentialGate integration', () => {
  beforeEach(() => resetAppSettingsState(uiStore))

  afterEach(() => {
    resetAppSettingsState(uiStore)
    configureModelCredentialHost(createUnavailableModelCredentialHost())
  })

  it('keeps the desktop workspace blocked until save recheck reports configured', async () => {
    const user = userEvent.setup()
    const host = createHost()
    configureModelCredentialHost(host)
    await hydrateModelCredentials()
    renderGate()

    const statusCallsBeforeSave = vi.mocked(host.status).mock.calls.length
    await user.type(screen.getByLabelText('DeepSeek API Key'), 'super-secret-key')
    await user.click(screen.getByRole('button', { name: '保存并进入' }))

    await waitFor(() => expect(vi.mocked(host.status).mock.calls.length).toBeGreaterThan(statusCallsBeforeSave))
    expect(host.save).toHaveBeenCalledWith({ provider: 'deepseek', scope: 'default' }, 'super-secret-key')
    expect(screen.queryByText('workspace')).not.toBeInTheDocument()
    expect(screen.queryByText('super-secret-key')).not.toBeInTheDocument()

    host.configured = true
    await user.click(screen.getByRole('button', { name: '重试检查' }))
    await waitFor(() => expect(screen.getByText('workspace')).toBeInTheDocument())
  })

  it('shows a safe retry error without exposing a rejected status secret', async () => {
    const user = userEvent.setup()
    const host = createHost({ statusError: true })
    configureModelCredentialHost(host)
    await hydrateModelCredentials()
    renderGate()

    expect(screen.getByRole('alert')).toHaveTextContent('无法读取 DeepSeek API Key 状态，请重试。')
    expect(screen.queryByText('secret-key-from-ipc')).not.toBeInTheDocument()
    expect(screen.queryByText('workspace')).not.toBeInTheDocument()

    host.statusError = false
    host.configured = true
    await user.click(screen.getByRole('button', { name: '重试检查' }))
    await waitFor(() => expect(screen.getByText('workspace')).toBeInTheDocument())
  })

  it('does not bypass the blocking dialog through Escape or outside clicks', async () => {
    const user = userEvent.setup()
    const host = createHost()
    configureModelCredentialHost(host)
    await hydrateModelCredentials()
    renderGate()

    fireEvent.keyDown(document, { key: 'Escape' })
    await user.click(screen.getByRole('dialog'))

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.queryByText('workspace')).not.toBeInTheDocument()
  })
})
