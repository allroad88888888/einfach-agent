import { uiStore } from '../../uiStore'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { rootStore } from '@web-agent/core'
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
    resetMcpSettingsState(uiStore)
    resetAppSettingsState(uiStore)
    configureAppSettingsStorage(createMemoryAppSettingsStorage())
    configureModelCredentialHost(createUnavailableModelCredentialHost())
    configureMcpSettings({ manager: new UiMcpManager(), storage: createMemoryMcpConfigStorage() })
  })

  afterEach(() => {
    resetMcpSettingsState(uiStore)
    resetAppSettingsState(uiStore)
  })

  it('warns about temporary browser storage and disables stdio selection', async () => {
    const user = userEvent.setup()
    renderWithStore(<SettingsCenter />, { store: uiStore })
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
    renderWithStore(<SettingsCenter />, { store: uiStore })
    await user.click(screen.getByRole('button', { name: '打开设置' }))
    await user.click(await screen.findByRole('button', { name: '+ 添加服务' }))
    await user.click(screen.getByRole('button', { name: 'JSON 导入' }))
    await user.click(screen.getByRole('button', { name: '导入配置' }))

    const card = await screen.findByRole('article', { name: 'MCP 服务 playwright' })
    expect(card).toHaveTextContent('stdio · 仅桌面端')
    expect(card).toHaveTextContent('未连接')
    expect(connect).not.toHaveBeenCalled()
  })

  it('asks for confirmation before the first stdio launch and only spawns after it (H2)', async () => {
    const user = userEvent.setup()
    const manager = new UiMcpManager()
    const connect = vi.spyOn(manager, 'connect')
    // 桌面端能力：这里 stdio 是真的能起进程的，所以确认必须先发生。
    configureMcpSettings({
      manager,
      storage: createMemoryMcpConfigStorage(),
      capabilities: { stdio: true },
    })
    renderWithStore(<SettingsCenter />, { store: uiStore })
    await user.click(screen.getByRole('button', { name: '打开设置' }))
    await user.click(await screen.findByRole('button', { name: '+ 添加服务' }))
    await user.type(screen.getByLabelText('服务名称'), '本地浏览器')
    await user.selectOptions(screen.getByLabelText('传输方式'), 'stdio')
    await user.type(screen.getByLabelText('启动命令'), 'npx')
    await user.type(screen.getByLabelText('启动参数'), '-y\n@playwright/mcp@latest')
    await user.click(screen.getByRole('button', { name: '保存服务' }))

    // 配置已经保存，但确认之前一个进程都没起。
    const card = await screen.findByRole('article', { name: 'MCP 服务 本地浏览器' })
    const prompt = await screen.findByRole('alert', { name: '确认启动 本地浏览器' })
    expect(prompt).toHaveTextContent('npx -y @playwright/mcp@latest')
    expect(connect).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: '确认并执行' }))

    await waitFor(() => expect(connect).toHaveBeenCalledTimes(1))
    expect(connect.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@playwright/mcp@latest'],
    }))
    // 确认落在配置上，提示随之消失；卡片不再说「尚未确认」。
    await waitFor(() =>
      expect(screen.queryByRole('alert', { name: '确认启动 本地浏览器' })).toBeNull())
    expect(card).not.toHaveTextContent('启动命令尚未确认')
  })

  it('浏览器端（无 credentials 能力）：请求头 / 环境变量输入被禁用并提示仅桌面端支持', async () => {
    const user = userEvent.setup()
    // stdio 能力单独开着，好让下面能切到 stdio 分支看 env 字段；credentials 仍然是 false——
    // 两个能力正交（见 McpSettingsCapabilities 的注释），这个组合只是为了在一次测试里
    // 覆盖两条分支，不代表真实宿主会长这样。
    configureMcpSettings({
      manager: new UiMcpManager(),
      storage: createMemoryMcpConfigStorage(),
      capabilities: { stdio: true },
    })
    renderWithStore(<SettingsCenter />, { store: uiStore })
    await user.click(screen.getByRole('button', { name: '打开设置' }))
    await user.click(await screen.findByRole('button', { name: '+ 添加服务' }))

    const headersField = screen.getByLabelText('请求头（可选）')
    expect(headersField).toBeDisabled()
    expect(headersField.closest('label')).toHaveTextContent('凭据字段仅桌面端支持')

    await user.selectOptions(screen.getByLabelText('传输方式'), 'stdio')
    const envField = screen.getByLabelText('环境变量（可选）')
    expect(envField).toBeDisabled()
    expect(envField.closest('label')).toHaveTextContent('凭据字段仅桌面端支持')
  })

  it('桌面端：HTTP 服务的请求头文本会解析并落到连接配置里', async () => {
    const user = userEvent.setup()
    const manager = new UiMcpManager()
    const connect = vi.spyOn(manager, 'connect')
    configureMcpSettings({
      manager,
      storage: createMemoryMcpConfigStorage(),
      capabilities: { stdio: true, credentials: true },
    })
    renderWithStore(<SettingsCenter />, { store: uiStore })
    await user.click(screen.getByRole('button', { name: '打开设置' }))
    await user.click(await screen.findByRole('button', { name: '+ 添加服务' }))
    await user.type(screen.getByLabelText('服务名称'), '带凭据的服务')
    await user.type(screen.getByLabelText('服务地址'), 'https://knowledge.example.com/mcp')
    await user.type(
      screen.getByLabelText('请求头（可选）'),
      'Authorization=Bearer sk-test\nX-Api-Key=abc',
    )
    await user.click(screen.getByRole('button', { name: '保存服务' }))

    await screen.findByRole('article', { name: 'MCP 服务 带凭据的服务' })
    await waitFor(() => expect(connect).toHaveBeenCalledTimes(1))
    expect(connect.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      headers: { Authorization: 'Bearer sk-test', 'X-Api-Key': 'abc' },
    }))
  })

  it('桌面端：stdio 服务的环境变量文本会解析并落到连接配置里', async () => {
    const user = userEvent.setup()
    const manager = new UiMcpManager()
    const connect = vi.spyOn(manager, 'connect')
    configureMcpSettings({
      manager,
      storage: createMemoryMcpConfigStorage(),
      capabilities: { stdio: true, credentials: true },
    })
    renderWithStore(<SettingsCenter />, { store: uiStore })
    await user.click(screen.getByRole('button', { name: '打开设置' }))
    await user.click(await screen.findByRole('button', { name: '+ 添加服务' }))
    await user.type(screen.getByLabelText('服务名称'), '带凭据的本地服务')
    await user.selectOptions(screen.getByLabelText('传输方式'), 'stdio')
    await user.type(screen.getByLabelText('启动命令'), 'npx')
    await user.type(screen.getByLabelText('启动参数'), '-y\n@playwright/mcp@latest')
    await user.type(screen.getByLabelText('环境变量（可选）'), 'API_KEY=sk-test')
    await user.click(screen.getByRole('button', { name: '保存服务' }))

    await screen.findByRole('article', { name: 'MCP 服务 带凭据的本地服务' })
    await user.click(screen.getByRole('button', { name: '确认并执行' }))

    await waitFor(() => expect(connect).toHaveBeenCalledTimes(1))
    expect(connect.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      env: { API_KEY: 'sk-test' },
    }))
  })

  it('请求头格式不是"键=值"时给出校验错误并阻止保存', async () => {
    const user = userEvent.setup()
    configureMcpSettings({
      manager: new UiMcpManager(),
      storage: createMemoryMcpConfigStorage(),
      capabilities: { stdio: true, credentials: true },
    })
    renderWithStore(<SettingsCenter />, { store: uiStore })
    await user.click(screen.getByRole('button', { name: '打开设置' }))
    await user.click(await screen.findByRole('button', { name: '+ 添加服务' }))
    await user.type(screen.getByLabelText('服务名称'), '格式错误')
    await user.type(screen.getByLabelText('服务地址'), 'https://knowledge.example.com/mcp')
    await user.type(screen.getByLabelText('请求头（可选）'), 'not-a-valid-line')

    expect(await screen.findByRole('alert')).toHaveTextContent('请求头')
    expect(screen.getByRole('button', { name: '保存服务' })).toBeDisabled()
  })

  it('adds an HTTP server and keeps invalid JSON editable', async () => {
    const user = userEvent.setup()
    renderWithStore(<SettingsCenter />, { store: uiStore })
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
