// 卡片页脚那一格：当前工具数（已连接）与上次已知清单（未连接）互斥（B5）。
//
// 判据落在整张卡片上而不是这个小组件上：这两个数字混淆的后果只在卡片语境里才成立
// （「3 个工具」紧挨着一个显示「未连接」的徽标）。

import { describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import { renderWithStore } from '../../test/renderWithStore'
import type { McpLastKnownTools } from '../../mcp/toolNameCache'
import type { McpServerView } from '../../mcp/types'
import { McpServerCard } from './McpServerCard'

vi.mock('../../mcp/commands', () => ({
  disconnectMcpServer: vi.fn(),
  reconnectMcpServer: vi.fn(),
  removeMcpServer: vi.fn(),
  setMcpServerAutoConnect: vi.fn(),
  approveMcpServerLaunch: vi.fn(),
  dismissMcpServerLaunch: vi.fn(),
}))

const CACHED_AT = Date.now() - 2 * 3_600_000

function lastKnown(overrides: Partial<McpLastKnownTools> = {}): McpLastKnownTools {
  return {
    serverId: 'srv-1',
    tools: [{ name: 'search', description: '搜索' }],
    toolCount: 4,
    truncated: false,
    cachedAt: CACHED_AT,
    probeStatus: 'success',
    ...overrides,
  }
}

function renderCard(overrides: Partial<McpServerView> = {}) {
  const server: McpServerView = {
    id: 'srv-1',
    name: '知识库',
    transport: 'streamable-http',
    target: 'https://example.com/mcp',
    autoConnect: false,
    args: [],
    status: 'disconnected',
    toolCount: 0,
    ...overrides,
  }
  renderWithStore(
    <McpServerCard server={server} stdioAvailable={false} temporaryStorage={false} />,
  )
  return screen.getByRole('article', { name: 'MCP 服务 知识库' })
}

describe('McpServerCard · 工具数与上次已知清单', () => {
  it('未连接：显示「上次可用工具 N 个」与探测时间', () => {
    const card = renderCard({ lastKnownTools: lastKnown() })

    expect(card).toHaveTextContent('上次可用工具 4 个')
    expect(card).toHaveTextContent('2 小时前')
  })

  it('未连接：绝不把「当前 0 个工具」摆出来当事实', () => {
    const card = renderCard({ lastKnownTools: lastKnown() })

    expect(card).not.toHaveTextContent('0 个工具')
  })

  it('已连接：显示当前真实工具数，不显示历史', () => {
    const card = renderCard({
      status: 'connected',
      toolCount: 3,
      lastKnownTools: lastKnown({ toolCount: 99 }),
    })

    expect(card).toHaveTextContent('3 个工具')
    expect(card).not.toHaveTextContent('上次可用工具')
    expect(card).not.toHaveTextContent('99')
  })

  it('从未探测过：说「尚未探测过」，不能说成 0 个工具', () => {
    const card = renderCard()

    expect(card).toHaveTextContent('尚未探测过工具清单')
    expect(card).not.toHaveTextContent('0 个工具')
  })

  it('探测到 0 个工具：如实说 0，且与「从未探测过」不是同一句话', () => {
    const card = renderCard({ lastKnownTools: lastKnown({ toolCount: 0, tools: [] }) })

    expect(card).toHaveTextContent('上次探测到 0 个工具')
    expect(card).not.toHaveTextContent('尚未探测过')
  })

  it('连接失败停在 error 时也给历史，那正是用户判断「值不值得修」的依据', () => {
    const card = renderCard({
      status: 'error',
      error: '身份认证失败，需要人工介入才能恢复：invalid api key',
      lastKnownTools: lastKnown({ toolCount: 7 }),
    })

    expect(card).toHaveTextContent('上次可用工具 7 个')
  })

  it('探测时刻在鼠标悬停时给出精确时间', () => {
    renderCard({ lastKnownTools: lastKnown() })

    expect(screen.getByTitle(/^探测于 /)).toHaveTextContent('上次可用工具 4 个')
  })
})
