import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { rootStore } from '@web-agent/core/state/rootStore'
import { renderWithStore } from '../../test/renderWithStore'
import { configureMcpSettings } from '../../mcp/commands'
import { createMemoryMcpConfigStorage } from '../../mcp/persistence'
import { resetMcpSettingsState } from '../../mcp/state'
import { configureAppSettingsStorage, configureModelCredentialHost } from '../../settings/commands'
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

describe('SettingsCenter MCP panel', () => {
  beforeEach(() => {
    resetMcpSettingsState(rootStore)
    resetAppSettingsState(rootStore)
    configureAppSettingsStorage(createMemoryAppSettingsStorage())
    configureModelCredentialHost(createUnavailableModelCredentialHost())
    configureMcpSettings({ manager: new UiMcpManager(), storage: createMemoryMcpConfigStorage() })
  })

  afterEach(() => {
    resetMcpSettingsState(rootStore)
    resetAppSettingsState(rootStore)
  })

  it('warns about temporary browser storage and disables stdio selection', async () => {
    const user = userEvent.setup()
    renderWithStore(<SettingsCenter />, { store: rootStore })
    await user.click(screen.getByRole('button', { name: '打开设置' }))
    expect(await screen.findByRole('status', { name: 'MCP 存储状态' })).toHaveTextContent('临时存储模式')
    await user.click(screen.getByRole('button', { name: '+ 添加服务' }))
    expect(screen.getByRole('option', { name: 'stdio（仅桌面端）' })).toBeDisabled()
  })

  it('imports stdio JSON without starting it in a browser host', async () => {
    const user = userEvent.setup()
    const manager = new UiMcpManager()
    const connect = vi.spyOn(manager, 'connect')
    configureMcpSettings({ manager, storage: createMemoryMcpConfigStorage() })
    renderWithStore(<SettingsCenter />, { store: rootStore })
    await user.click(screen.getByRole('button', { name: '打开设置' }))
    await user.click(await screen.findByRole('button', { name: '+ 添加服务' }))
    await user.click(screen.getByRole('button', { name: 'JSON 导入' }))
    await user.click(screen.getByRole('button', { name: '导入配置' }))

    const card = await screen.findByRole('article', { name: 'MCP 服务 playwright' })
    expect(card).toHaveTextContent('stdio · 仅桌面端')
    expect(card).toHaveTextContent('未连接')
    expect(connect).not.toHaveBeenCalled()
  })

  it('adds an HTTP server and keeps invalid JSON editable', async () => {
    const user = userEvent.setup()
    renderWithStore(<SettingsCenter />, { store: rootStore })
    await user.click(screen.getByRole('button', { name: '打开设置' }))
    await user.click(await screen.findByRole('button', { name: '+ 添加服务' }))
    await user.type(screen.getByLabelText('服务名称'), '团队知识库')
    await user.type(screen.getByLabelText('服务地址'), 'https://knowledge.example.com/mcp')
    await user.click(screen.getByRole('button', { name: '保存服务' }))
    const card = await screen.findByRole('article', { name: 'MCP 服务 团队知识库' })
    expect(card).toHaveTextContent('已连接')
    await user.click(screen.getByRole('button', { name: '+ 添加服务' }))
    await user.click(screen.getByRole('button', { name: 'JSON 导入' }))
    const input = screen.getByLabelText('MCP JSON 配置')
    fireEvent.change(input, { target: { value: '{"mcpServers":' } })
    await user.click(screen.getByRole('button', { name: '导入配置' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('MCP JSON 格式无效'))
    expect(input).toHaveValue('{"mcpServers":')
  })
})
