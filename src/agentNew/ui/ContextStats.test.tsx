import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import { createStore } from '@einfach/core'
import { renderWithStore } from '../../test/renderWithStore'
import { contextStatsAtom, type ContextStatsSnapshot } from '@web-agent/core/state/transientAtoms'
import { ContextStats } from './ContextStats'

const baseStats: ContextStatsSnapshot = {
  id: 'ctx1',
  createdAt: 1,
  vendor: 'deepseek',
  model: 'deepseek-chat',
  runId: 'r1',
  turnId: 'u1',
  llmTurn: 1,
  messagesCount: 2,
  toolsCount: 1,
  systemChars: 120,
  messagesChars: 240,
  toolsChars: 160,
  totalChars: 400,
  estimatedTokens: 100,
  roles: {
    system: { count: 1, chars: 120, estimatedTokens: 30 },
    user: { count: 1, chars: 120, estimatedTokens: 30 },
    assistant: { count: 0, chars: 0, estimatedTokens: 0 },
    tool: { count: 0, chars: 0, estimatedTokens: 0 },
  },
  toolNames: ['request_tool_schema'],
}

describe('ContextStats', () => {
  it('无统计时不渲染', () => {
    const { container } = renderWithStore(<ContextStats />, { store: createStore() })
    expect(container.firstChild).toBeNull()
  })

  it('有估算统计时渲染摘要和明细', () => {
    const store = createStore()
    store.setter(contextStatsAtom, baseStats)

    renderWithStore(<ContextStats />, { store })

    expect(screen.getByLabelText('上下文统计')).toBeInTheDocument()
    expect(screen.getByText(/上下文估算 100 tokens/)).toBeInTheDocument()
    expect(screen.getByText(/^tools 1$/)).toBeInTheDocument()
    expect(screen.getByText('deepseek/deepseek-chat')).toBeInTheDocument()
    expect(screen.getByText('request_tool_schema')).toBeInTheDocument()
    expect(screen.queryByText(/system 1/)).toBeNull()
  })

  it('provider 返回 usage 后优先展示真实 usage 摘要', () => {
    const store = createStore()
    store.setter(contextStatsAtom, {
      ...baseStats,
      usage: { promptTokens: 120, completionTokens: 30, totalTokens: 150 },
    })

    renderWithStore(<ContextStats />, { store })

    expect(screen.getByText(/上下文 prompt 120 · total 150/)).toBeInTheDocument()
    expect(screen.getByText(/prompt 120 \/ completion 30 \/ total 150/)).toBeInTheDocument()
  })
})
