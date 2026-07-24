import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type {
  McpServerConfig,
  McpServerSnapshot,
} from '@web-agent/tools-mcp'
import { rootStore } from '@web-agent/core/state/rootStore'
import { configureCommands } from '@web-agent/core/runtime/commands'
import { defaultCore } from '@web-agent/core/runtime/core/coreInstance'
import { renderWithStore } from '../../test/renderWithStore'
import { configureMcpSettings } from '../../mcp/commands'
import { createMemoryMcpConfigStorage } from '../../mcp/persistence'
import { resetMcpSettingsState } from '../../mcp/state'
import type { McpSettingsManager } from '../../mcp/service'
import {
  configureAppSettingsEnvironment,
  configureAppSettingsStorage,
} from '../../settings/commands'
import {
  createMemoryAppSettingsStorage,
  type AppSettingsStorage,
} from '../../settings/persistence'
import { resetAppSettingsState } from '../../settings/state'
import { SettingsCenter } from './SettingsCenter'

const originalShowModal = Object.getOwnPropertyDescriptor(
  HTMLDialogElement.prototype,
  'showModal',
)
const originalClose = Object.getOwnPropertyDescriptor(
  HTMLDialogElement.prototype,
  'close',
)
const showModalMock = vi.fn(function showModal(this: HTMLDialogElement) {
  this.setAttribute('open', '')
})
const closeMock = vi.fn(function close(this: HTMLDialogElement) {
  this.removeAttribute('open')
  this.dispatchEvent(new Event('close'))
})

beforeAll(() => {
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: {
      configurable: true,
      writable: true,
      value: showModalMock,
    },
    close: {
      configurable: true,
      writable: true,
      value: closeMock,
    },
  })
})

afterAll(() => {
  if (originalShowModal) {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', originalShowModal)
  } else {
    delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).showModal
  }
  if (originalClose) {
    Object.defineProperty(HTMLDialogElement.prototype, 'close', originalClose)
  } else {
    delete (HTMLDialogElement.prototype as Partial<HTMLDialogElement>).close
  }
})

function connectedSnapshot(config: McpServerConfig): McpServerSnapshot {
  return {
    id: config.id,
    config,
    status: 'connected',
    tools: [{
      name: `mcp__${config.id}__search`,
      remoteName: 'search',
      description: 'Search',
      inputSchema: { type: 'object' },
    }],
  }
}

class UiMcpManager implements McpSettingsManager {
  private readonly snapshots = new Map<string, McpServerSnapshot>()
  private readonly listeners = new Set<(servers: readonly McpServerSnapshot[]) => void>()

  async connect(config: McpServerConfig): Promise<McpServerSnapshot> {
    const next = connectedSnapshot(config)
    this.snapshots.set(config.id, next)
    this.emit()
    return next
  }

  async reconnect(id: string): Promise<McpServerSnapshot> {
    const current = this.snapshots.get(id)
    if (!current) throw new Error('unknown server')
    const next = connectedSnapshot(current.config)
    this.snapshots.set(id, next)
    this.emit()
    return next
  }

  async disconnect(id: string): Promise<McpServerSnapshot | undefined> {
    const current = this.snapshots.get(id)
    if (!current) return undefined
    const next: McpServerSnapshot = {
      ...current,
      status: 'disconnected',
      tools: [],
    }
    this.snapshots.set(id, next)
    this.emit()
    return next
  }

  async remove(id: string): Promise<boolean> {
    const removed = this.snapshots.delete(id)
    this.emit()
    return removed
  }

  get(id: string): McpServerSnapshot | undefined {
    return this.snapshots.get(id)
  }

  list(): readonly McpServerSnapshot[] {
    return [...this.snapshots.values()]
  }

  subscribe(listener: (servers: readonly McpServerSnapshot[]) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.list())
  }
}

describe('SettingsCenter', () => {
  let appSettingsStorage: AppSettingsStorage

  beforeEach(() => {
    showModalMock.mockClear()
    closeMock.mockClear()
    resetMcpSettingsState(rootStore)
    resetAppSettingsState(rootStore)
    configureCommands({ customInstructions: '', deepseekApiKey: '' })
    configureAppSettingsEnvironment({ deepseekApiKey: '' })
    appSettingsStorage = createMemoryAppSettingsStorage()
    configureAppSettingsStorage(appSettingsStorage)
    configureMcpSettings({
      manager: new UiMcpManager(),
      storage: createMemoryMcpConfigStorage(),
    })
  })

  afterEach(() => {
    resetMcpSettingsState(rootStore)
    resetAppSettingsState(rootStore)
    configureCommands({ customInstructions: '', deepseekApiKey: '' })
    configureAppSettingsEnvironment({ deepseekApiKey: '' })
  })

  it('opens from the sidebar and exposes model settings while general remains a placeholder', async () => {
    const user = userEvent.setup()
    renderWithStore(<SettingsCenter />, { store: rootStore })

    const launchButton = screen.getByRole('button', { name: '打开设置' })
    await user.click(launchButton)

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toBeVisible()
    expect(dialog).toHaveAttribute('open')
    expect(showModalMock).toHaveBeenCalledTimes(1)
    const closeButton = screen.getByRole('button', { name: '关闭设置' })
    const lastButton = screen.getByRole('button', { name: '+ 添加服务' })
    expect(closeButton).toHaveFocus()
    lastButton.focus()
    await user.tab()
    expect(closeButton).toHaveFocus()
    await user.tab({ shift: true })
    expect(lastButton).toHaveFocus()
    expect(screen.getByRole('heading', { name: 'MCP 服务' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '模型' }))
    expect(screen.getByRole('heading', { name: '模型' })).toBeInTheDocument()
    expect(screen.getByText('DeepSeek V4 Pro')).toBeInTheDocument()
    expect(screen.getByText('DeepSeek V4 Flash')).toBeInTheDocument()
    expect(screen.getByLabelText('模型分工')).toHaveTextContent('deepseek-v4-pro')
    expect(screen.getByLabelText('模型分工')).toHaveTextContent('deepseek-v4-flash')
    expect(screen.getByText(/Flash 只用于主 Agent 明确判定/)).toBeInTheDocument()
    expect(screen.getByLabelText('DeepSeek API Key')).toHaveAttribute('type', 'password')
    await user.click(screen.getByRole('button', { name: '通用' }))
    expect(screen.getByRole('heading', { name: '通用' })).toBeInTheDocument()
    expect(screen.getByText('暂未开放')).toBeInTheDocument()

    fireEvent(dialog, new Event('cancel', { cancelable: true }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(closeMock).toHaveBeenCalledTimes(1)
    expect(launchButton).toHaveFocus()
  })

  it('clearly warns when MCP settings are only stored for the current session', async () => {
    const user = userEvent.setup()
    renderWithStore(<SettingsCenter />, { store: rootStore })

    await user.click(screen.getByRole('button', { name: '打开设置' }))

    const storageStatus = screen.getByRole('status', { name: 'MCP 存储状态' })
    expect(storageStatus).toHaveTextContent('临时存储模式')
    expect(storageStatus).toHaveTextContent('刷新或关闭页面后会丢失')

    await user.click(screen.getByRole('button', { name: '+ 添加服务' }))
    expect(screen.getByText(/配置和偏好仅在本次会话有效/)).toBeInTheDocument()
  })

  it('marks stdio as desktop-only and prevents selecting it in a browser host', async () => {
    const user = userEvent.setup()
    renderWithStore(<SettingsCenter />, { store: rootStore })
    await user.click(screen.getByRole('button', { name: '打开设置' }))
    await user.click(screen.getByRole('button', { name: '+ 添加服务' }))

    expect(screen.getByRole('option', { name: 'stdio（仅桌面端）' })).toBeDisabled()
    expect(screen.getByText('浏览器端仅支持 Streamable HTTP。')).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: '传输方式' })).toHaveValue('streamable-http')
  })

  it('imports the common mcpServers JSON shape without starting stdio in the browser', async () => {
    const user = userEvent.setup()
    const manager = new UiMcpManager()
    const storage = createMemoryMcpConfigStorage()
    const connect = vi.spyOn(manager, 'connect')
    configureMcpSettings({ manager, storage })
    renderWithStore(<SettingsCenter />, { store: rootStore })

    await user.click(screen.getByRole('button', { name: '打开设置' }))
    await user.click(screen.getByRole('button', { name: '+ 添加服务' }))
    await user.click(screen.getByRole('button', { name: 'JSON 导入' }))

    const jsonInput = screen.getByLabelText('MCP JSON 配置')
    expect((jsonInput as HTMLTextAreaElement).value)
      .toContain('"@playwright/mcp@latest"')
    expect(screen.getByText(/stdio 配置可以保存，但浏览器无法启动/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '导入配置' }))

    const card = await screen.findByRole('article', { name: 'MCP 服务 playwright' })
    expect(card).toHaveTextContent('stdio · 仅桌面端')
    expect(card).toHaveTextContent('npx')
    expect(card).toHaveTextContent('参数：@playwright/mcp@latest')
    expect(card).toHaveTextContent('未连接')
    expect(screen.getByText('已导入 1 个 MCP 服务，均保持未连接')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重连' })).toBeDisabled()
    expect(connect).not.toHaveBeenCalled()
    expect(storage.load()).toEqual([expect.objectContaining({
      name: 'playwright',
      transport: 'stdio',
      command: 'npx',
      args: ['@playwright/mcp@latest'],
      autoConnect: false,
    })])
  })

  it('keeps invalid JSON editable and reports the parse error inline', async () => {
    const user = userEvent.setup()
    renderWithStore(<SettingsCenter />, { store: rootStore })
    await user.click(screen.getByRole('button', { name: '打开设置' }))
    await user.click(screen.getByRole('button', { name: '+ 添加服务' }))
    await user.click(screen.getByRole('button', { name: 'JSON 导入' }))

    const jsonInput = screen.getByLabelText('MCP JSON 配置')
    fireEvent.change(jsonInput, { target: { value: '{"mcpServers":' } })
    await user.click(screen.getByRole('button', { name: '导入配置' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('MCP JSON 格式无效')
    expect(jsonInput).toHaveValue('{"mcpServers":')
    expect(jsonInput).toHaveAttribute('aria-invalid', 'true')
    expect(jsonInput).toHaveAttribute(
      'aria-describedby',
      'agentnew-mcp-json-help agentnew-mcp-form-error',
    )
  })

  it('saves global custom instructions and applies them to the agent runtime', async () => {
    const user = userEvent.setup()
    renderWithStore(<SettingsCenter />, { store: rootStore })
    await user.click(screen.getByRole('button', { name: '打开设置' }))
    await user.click(screen.getByRole('button', { name: '自定义指令' }))

    const textarea = screen.getByPlaceholderText('例如：请始终使用中文回复。')
    await user.type(textarea, '请始终使用中文回复')
    await user.click(screen.getByRole('button', { name: '保存指令' }))

    expect(screen.getByRole('status')).toHaveTextContent('已保存')
    expect(appSettingsStorage.load().agent.customInstructions).toBe('请始终使用中文回复')
    expect(defaultCore.config.customInstructions).toBe('请始终使用中文回复')
    expect(screen.getByRole('button', { name: '保存指令' })).toBeDisabled()
  })

  it('saves the DeepSeek V4 key and applies it to the runtime', async () => {
    const user = userEvent.setup()
    renderWithStore(<SettingsCenter />, { store: rootStore })
    await user.click(screen.getByRole('button', { name: '打开设置' }))
    await user.click(screen.getByRole('button', { name: '模型' }))

    const input = screen.getByLabelText('DeepSeek API Key')
    expect(input).toHaveAttribute('type', 'password')
    await user.type(input, 'deepseek-test-key')
    await user.click(screen.getByRole('button', { name: '保存模型设置' }))

    expect(screen.getByRole('status')).toHaveTextContent('模型设置已保存')
    expect(appSettingsStorage.load().providers.deepseek.apiKey).toBe('deepseek-test-key')
    expect(defaultCore.config.deepseekApiKey).toBe('deepseek-test-key')
    expect(screen.getByRole('button', { name: '保存模型设置' })).toBeDisabled()
  })

  it('adds an HTTP server and exposes status, transport, endpoint, tool count, and lifecycle actions', async () => {
    const user = userEvent.setup()
    renderWithStore(<SettingsCenter />, { store: rootStore })
    await user.click(screen.getByRole('button', { name: '打开设置' }))
    await user.click(screen.getByRole('button', { name: '+ 添加服务' }))

    await user.type(screen.getByLabelText('服务名称'), '团队知识库')
    await user.type(screen.getByLabelText('服务地址'), 'https://knowledge.example.com/mcp')
    await user.click(screen.getByRole('button', { name: '保存服务' }))

    const card = await screen.findByRole('article', { name: 'MCP 服务 团队知识库' })
    expect(card).toHaveTextContent('Streamable HTTP')
    expect(card).toHaveTextContent('https://knowledge.example.com/mcp')
    expect(card).toHaveTextContent('已连接')
    expect(card).toHaveTextContent('1 个工具')
    const autoConnect = screen.getByRole('checkbox', { name: '团队知识库 自动连接' })
    expect(autoConnect).toBeChecked()
    expect(card).toHaveTextContent('切换会立即连接或注销；偏好仅在本次会话有效')

    await user.click(autoConnect)
    await waitFor(() => expect(card).toHaveTextContent('未连接'))
    expect(autoConnect).not.toBeChecked()

    await user.click(autoConnect)
    await waitFor(() => expect(card).toHaveTextContent('已连接'))
    expect(autoConnect).toBeChecked()

    await user.click(screen.getByRole('button', { name: '注销' }))
    await waitFor(() => expect(card).toHaveTextContent('未连接'))
    expect(card).toHaveTextContent('0 个工具')

    await user.click(screen.getByRole('button', { name: '重连' }))
    await waitFor(() => expect(card).toHaveTextContent('已连接'))
    await user.click(screen.getByRole('button', { name: '删除' }))
    await waitFor(() => {
      expect(screen.queryByRole('article', { name: 'MCP 服务 团队知识库' })).toBeNull()
    })
    expect(screen.getByText('还没有 MCP 服务')).toBeInTheDocument()
  })

  it('switches the add form to stdio and renders command-specific fields', async () => {
    const user = userEvent.setup()
    configureMcpSettings({
      manager: new UiMcpManager(),
      storage: createMemoryMcpConfigStorage(),
      capabilities: { stdio: true },
    })
    renderWithStore(<SettingsCenter />, { store: rootStore })
    await user.click(screen.getByRole('button', { name: '打开设置' }))
    await user.click(screen.getByRole('button', { name: '+ 添加服务' }))
    await user.selectOptions(
      screen.getByRole('combobox', { name: '传输方式' }),
      'stdio',
    )

    expect(screen.getByLabelText('启动命令')).toBeInTheDocument()
    expect(screen.getByLabelText('启动参数')).toBeInTheDocument()
    expect(screen.getByLabelText('工作目录')).toBeInTheDocument()
    expect(screen.queryByLabelText('服务地址')).toBeNull()
    expect(screen.queryByLabelText('保存后自动连接')).toBeNull()
    expect(screen.getByText('仅手动连接')).toBeInTheDocument()
    expect(screen.getByText(/不会从浏览器存储自动执行/)).toBeInTheDocument()

    await user.type(screen.getByLabelText('服务名称'), 'Playwright MCP')
    await user.type(screen.getByLabelText('启动命令'), 'npx')
    await user.type(screen.getByLabelText('启动参数'), '-y{enter}@playwright/mcp@latest')
    await user.click(screen.getByRole('button', { name: '保存服务' }))

    const card = await screen.findByRole('article', { name: 'MCP 服务 Playwright MCP' })
    expect(card).toHaveTextContent('stdio')
    expect(card).toHaveTextContent('npx')
    expect(card).toHaveTextContent('参数：-y · @playwright/mcp@latest')
    expect(card).toHaveTextContent('未连接')
    expect(card).toHaveTextContent('0 个工具')
    expect(card).toHaveTextContent('本地进程需每次手动重连')
    expect(screen.queryByRole('checkbox', { name: 'Playwright MCP 自动连接' })).toBeNull()

    await user.click(screen.getByRole('button', { name: '重连' }))
    await waitFor(() => expect(card).toHaveTextContent('已连接'))
    expect(card).toHaveTextContent('1 个工具')
  })
})
