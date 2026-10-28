import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ConversationItem, SessionTurnHistoryProjection } from '@einfach-agent/core'
import { ConversationTimeline } from './ConversationTimeline'

const user: ConversationItem = { id: 'u1', createdAt: 1, item: { role: 'user', content: '需要修改' } }

function timeline(turnHistory: SessionTurnHistoryProjection, onRetract = vi.fn()) {
  render(<ConversationTimeline items={turnHistory.turns.filter((turn) => turn.state === 'active').map((turn) => turn.userItem)} runtimeEvents={[]} browserCards={[]} turnHistory={turnHistory} onRetract={onRetract} />)
  return { onRetract }
}

describe('per-message history actions', () => {
  it('places an exact undo action below the active user message', () => {
    const { onRetract } = timeline({ turns: [{ userItem: user, state: 'active' }] })
    fireEvent.click(screen.getByRole('button', { name: /撤销此消息及后续对话/ }))
    expect(onRetract).toHaveBeenCalledWith('u1')
    expect(screen.queryByText('会话操作')).not.toBeInTheDocument()
  })

  it('removes retracted messages and shows the empty state without redo', () => {
    timeline({ turns: [{ userItem: user, state: 'retracted' }] })
    expect(screen.getByText('准备好了')).toBeInTheDocument()
    expect(screen.queryByText('需要修改')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重做' })).not.toBeInTheDocument()
  })

  it('keeps a blocked reason keyboard reachable and rejects Enter and Space', async () => {
    const userInput = userEvent.setup()
    const { onRetract } = timeline({ turns: [{ userItem: user, state: 'active', blocked: 'irreversible_barrier' }] })
    const button = screen.getByRole('button', { name: '外部操作形成不可逆边界，无法撤销此消息。' })
    const reason = screen.getByText('外部操作形成不可逆边界，无法撤销此消息。')
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).toHaveAttribute('aria-describedby', reason.id)

    await userInput.tab()
    expect(button).toHaveFocus()
    await userInput.keyboard('{Enter}')
    await userInput.keyboard(' ')
    expect(onRetract).not.toHaveBeenCalled()
  })

  it('explains that undo stops an in-flight run and cannot reverse external actions', () => {
    timeline({ turns: [{ userItem: user, state: 'active', willStopRun: true }] })
    expect(screen.getByRole('button', { name: /当前运行会先停止.*不能撤销已在网页或业务系统执行的操作/ })).toBeEnabled()
  })
})
