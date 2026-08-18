import { uiStore } from '../../uiStore'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { rootStore } from '@web-agent/core'
import { renderWithStore } from '../../test/renderWithStore'
import {
  configureModelCredentialHost,
  hydrateModelCredentials,
} from '../../settings/commands'
import type { ModelCredentialHost, ModelCredentialTarget } from '../../settings/modelCredentialHost'
import { createUnavailableModelCredentialHost } from '../../settings/modelCredentialHost'
import { resetAppSettingsState } from '../../settings/state'
import { StartupCredentialGate } from './StartupCredentialGate'

const deepSeekTarget = { ok: true, id: 'deepseek-default' } as const

function targetKey(target: ModelCredentialTarget): string {
  return `${target.provider}:${target.scope}`
}

function credentialHost(options: { configured?: boolean; failStatus?: boolean } = {}): ModelCredentialHost {
  const saved = new Set<string>(options.configured ? ['deepseek:default'] : [])
  return {
    available: true,
    status: vi.fn(async (target) => {
      if (options.failStatus) throw new Error('raw-secret-from-host')
      const configured = saved.has(targetKey(target))
      return { configured, source: configured ? 'config' as const : 'missing' as const }
    }),
    save: vi.fn(async (target) => {
      saved.add(targetKey(target))
      return { configured: true, source: 'config' as const }
    }),
    delete: vi.fn(async () => ({ configured: false, source: 'missing' as const })),
  }
}

function renderGate(enabled = true) {
  return renderWithStore(
    <StartupCredentialGate enabled={enabled} target={deepSeekTarget}>
      <p>workspace</p>
    </StartupCredentialGate>,
    // 应用层命令（hydrateModelCredentials…）写的是模块级单例 uiStore，渲染必须绑同一个。
    { store: uiStore },
  )
}

describe('StartupCredentialGate', () => {
  beforeEach(() => {
    resetAppSettingsState(uiStore)
  })

  afterEach(() => {
    resetAppSettingsState(uiStore)
    configureModelCredentialHost(createUnavailableModelCredentialHost())
  })

  it('passes through unchanged outside the desktop host', () => {
    renderGate(false)

    expect(screen.getByText('workspace')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('blocks a missing key until it is saved', async () => {
    const user = userEvent.setup()
    const host = credentialHost()
    configureModelCredentialHost(host)
    await hydrateModelCredentials()
    renderGate()

    expect(screen.queryByText('workspace')).not.toBeInTheDocument()
    const input = screen.getByLabelText('DeepSeek API Key')
    await user.type(input, 'secret-key')
    await user.click(screen.getByRole('button', { name: '保存并进入' }))

    await waitFor(() => expect(screen.getByText('workspace')).toBeInTheDocument())
    expect(host.save).toHaveBeenCalledWith({ provider: 'deepseek', scope: 'default' }, 'secret-key')
    expect(input).not.toBeInTheDocument()
  })

  it('passes through when the selected credential is configured', async () => {
    configureModelCredentialHost(credentialHost({ configured: true }))
    await hydrateModelCredentials()
    renderGate()

    expect(screen.getByText('workspace')).toBeInTheDocument()
  })

  it('retries an unreadable credential status', async () => {
    const host = credentialHost({ failStatus: true })
    configureModelCredentialHost(host)
    await hydrateModelCredentials()
    renderGate()

    expect(screen.getByRole('alert')).toHaveTextContent('无法读取 DeepSeek API Key 状态，请重试。')
    expect(screen.queryByText('raw-secret-from-host')).not.toBeInTheDocument()
    ;(host.status as ReturnType<typeof vi.fn>).mockImplementation(async (target) => ({
      configured: target.provider === 'deepseek', source: 'config' as const,
    }))
    fireEvent.click(screen.getByRole('button', { name: '重试检查' }))

    await waitFor(() => expect(screen.getByText('workspace')).toBeInTheDocument())
  })

  it('does not allow Escape to bypass the gate', async () => {
    configureModelCredentialHost(credentialHost())
    await hydrateModelCredentials()
    renderGate()

    fireEvent.keyDown(document, { key: 'Escape' })

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.queryByText('workspace')).not.toBeInTheDocument()
  })
})
