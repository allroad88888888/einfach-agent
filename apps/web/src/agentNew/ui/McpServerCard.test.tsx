import { describe, it, expect, afterEach, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithStore } from '../../test/renderWithStore'
import {
  approveMcpServerLaunch,
  dismissMcpServerLaunch,
  setMcpServerAutoConnect,
} from '../../mcp/commands'
import type { McpLaunchConsentRequest } from '../../mcp/launchConsentState'
import type { McpServerView } from '../../mcp/types'
import { McpServerCard } from './McpServerCard'

// D4：重试中（暂时失败，可以等）与永久失败（需要人工介入）在卡片上必须能区分
// 开——徽标文案、说明区域的语气（role="status" vs role="alert"）和具体建议都
// 不一样。这里把 mcp/commands 整模块 mock 掉，因为本文件只断言渲染差异，不
// 需要真的触发 disconnect/reconnect/remove/setAutoConnect 的副作用。
vi.mock('../../mcp/commands', () => ({
  disconnectMcpServer: vi.fn(),
  reconnectMcpServer: vi.fn(),
  removeMcpServer: vi.fn(),
  setMcpServerAutoConnect: vi.fn(),
  approveMcpServerLaunch: vi.fn(),
  dismissMcpServerLaunch: vi.fn(),
}))

function baseServer(overrides: Partial<McpServerView>): McpServerView {
  return {
    id: 'srv-1',
    name: '知识库',
    transport: 'streamable-http',
    target: 'https://example.com/mcp',
    autoConnect: true,
    args: [],
    status: 'connected',
    toolCount: 3,
    ...overrides,
  }
}

describe('McpServerCard', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('暂时失败且当前没有进行中的重连（idle）：徽标不说"重连中"，说明区域是 role=status，不提"人工介入"', () => {
    const server = baseServer({
      status: 'reconnecting',
      error: '连接暂时中断，可以重试：peer closed the connection',
    })
    renderWithStore(<McpServerCard server={server} stdioAvailable={false} temporaryStorage={false} />)

    const card = screen.getByRole('article', { name: 'MCP 服务 知识库' })
    // 徽标：不是"重连中"（那会让人以为系统正在自动处理），是"连接不稳定"。
    expect(card).toHaveTextContent('连接不稳定')
    expect(card).not.toHaveTextContent('重连中')

    const note = screen.getByRole('status')
    expect(note).toHaveTextContent('暂时中断，正在自动重连')
    expect(note).toHaveTextContent('连接暂时中断，可以重试：peer closed the connection')
    // D2 落地后自动退避重连是真实存在的，且有次数上限——文案必须把上限说出来，
    // 不能只说「正在自动重连」而让用户以为会一直试下去。
    expect(note).toHaveTextContent('最多 6 次')
    expect(note).not.toHaveTextContent('人工介入')
    // 认证失败也落在 reconnecting（无 401/403 时凭证错与临时故障无法区分），
    // 所以这一档不能断言「与配置无关」——那会和分类文案的「请检查凭证配置」打架。
    expect(note).not.toHaveTextContent('不是配置问题')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('暂时失败但正在重连中（busy）：徽标说"重连中"，不渲染说明区域', () => {
    const server = baseServer({ status: 'reconnecting' })
    renderWithStore(
      <McpServerCard
        server={server}
        operation="reconnect"
        stdioAvailable={false}
        temporaryStorage={false}
      />,
    )

    const card = screen.getByRole('article', { name: 'MCP 服务 知识库' })
    expect(card).toHaveTextContent('重连中')
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('永久失败：徽标说"需要处理"，说明区域是 role=alert，给出可执行的下一步', () => {
    const server = baseServer({
      status: 'error',
      error: '身份认证失败，需要人工介入才能恢复：invalid api key',
    })
    renderWithStore(<McpServerCard server={server} stdioAvailable={false} temporaryStorage={false} />)

    const card = screen.getByRole('article', { name: 'MCP 服务 知识库' })
    expect(card).toHaveTextContent('需要处理')

    const note = screen.getByRole('alert')
    expect(note).toHaveTextContent('需要你处理')
    expect(note).toHaveTextContent('身份认证失败，需要人工介入才能恢复：invalid api key')
    expect(note).toHaveTextContent('检查服务地址、启动命令、参数或访问凭据')
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('已连接：不渲染任何说明区域', () => {
    const server = baseServer({ status: 'connected' })
    renderWithStore(<McpServerCard server={server} stdioAvailable={false} temporaryStorage={false} />)

    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
  })
})

// H2：起进程前的确认长在【它自己那张卡片】上——一次导入可能带进来好几个 stdio 服务，
// 「哪条命令属于哪个服务」不能靠顺序猜。
describe('McpServerCard · stdio 起进程确认', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  function stdioServer(overrides: Partial<McpServerView> = {}): McpServerView {
    return baseServer({
      id: 'playwright',
      name: 'Playwright MCP',
      transport: 'stdio',
      target: 'npx',
      args: ['-y', '@playwright/mcp@latest'],
      autoConnect: false,
      status: 'disconnected',
      toolCount: 0,
      ...overrides,
    })
  }

  const REQUEST: McpLaunchConsentRequest = {
    id: 'playwright',
    name: 'Playwright MCP',
    commandLine: 'npx -y @playwright/mcp@latest',
    reason: 'install',
    autoConnect: false,
  }

  it('待确认时把完整命令行摆出来，两个按钮各自调对应命令', async () => {
    const user = userEvent.setup()
    renderWithStore(
      <McpServerCard
        server={stdioServer()}
        stdioAvailable
        temporaryStorage={false}
        launchRequest={REQUEST}
        launchConfirmed={false}
      />,
    )

    const prompt = screen.getByRole('alert', { name: '确认启动 Playwright MCP' })
    expect(prompt).toHaveTextContent('npx -y @playwright/mcp@latest')
    // 不能只说「会启动一个本地进程」——用户要能逐字核对自己批准的是什么。
    expect(prompt).toHaveTextContent('会在你的电脑上执行')

    await user.click(screen.getByRole('button', { name: '确认并执行' }))
    expect(approveMcpServerLaunch).toHaveBeenCalledWith('playwright')

    await user.click(screen.getByRole('button', { name: '暂不执行' }))
    expect(dismissMcpServerLaunch).toHaveBeenCalledWith('playwright')
  })

  it('自动连接开启时提示说明「之后每次启动都会自动执行」', () => {
    renderWithStore(
      <McpServerCard
        server={stdioServer({ autoConnect: true })}
        stdioAvailable
        temporaryStorage={false}
        launchRequest={{ ...REQUEST, reason: 'auto-connect', autoConnect: true }}
        launchConfirmed={false}
      />,
    )

    expect(screen.getByRole('alert')).toHaveTextContent('每次启动应用都会自动执行')
  })

  it('未确认且没有待确认请求：说清楚为什么没连，并指向「重连」', () => {
    renderWithStore(
      <McpServerCard
        server={stdioServer()}
        stdioAvailable
        temporaryStorage={false}
        launchConfirmed={false}
      />,
    )

    const note = screen.getByRole('status')
    expect(note).toHaveTextContent('启动命令尚未确认')
    expect(note).toHaveTextContent('重连')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('stdio 也有自动连接开关：它是偏好，执行权归确认（H2）', async () => {
    const user = userEvent.setup()
    renderWithStore(
      <McpServerCard
        server={stdioServer()}
        stdioAvailable
        temporaryStorage={false}
        launchConfirmed={false}
      />,
    )

    const toggle = screen.getByRole('checkbox', { name: 'Playwright MCP 自动连接' })
    expect(toggle).not.toBeChecked()
    expect(screen.getByRole('article', { name: 'MCP 服务 Playwright MCP' }))
      .toHaveTextContent('首次需确认命令行')

    await user.click(toggle)
    // UI 只负责表达偏好；起不起进程由 service 那边的确认门决定。
    expect(setMcpServerAutoConnect).toHaveBeenCalledWith('playwright', true)
  })

  it('浏览器里不给 stdio 开关，也不提确认：那里根本起不了进程', () => {
    renderWithStore(
      <McpServerCard
        server={stdioServer()}
        stdioAvailable={false}
        temporaryStorage={false}
        launchConfirmed={false}
      />,
    )

    expect(screen.queryByRole('checkbox')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByRole('article', { name: 'MCP 服务 Playwright MCP' }))
      .toHaveTextContent('仅桌面端')
  })

  it('已经连上的 stdio 不说「尚未确认」：模型那条路径（F3 的工具确认）也能把它连起来', () => {
    renderWithStore(
      <McpServerCard
        server={stdioServer({ status: 'connected', toolCount: 2 })}
        stdioAvailable
        temporaryStorage={false}
        launchConfirmed={false}
      />,
    )

    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('已确认过的 stdio：开关照常用，不再显示任何确认提示', () => {
    renderWithStore(
      <McpServerCard
        server={stdioServer({ autoConnect: true, status: 'connected', toolCount: 3 })}
        stdioAvailable
        temporaryStorage={false}
      />,
    )

    expect(screen.getByRole('checkbox', { name: 'Playwright MCP 自动连接' })).toBeChecked()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
  })
})
