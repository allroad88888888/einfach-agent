import { createStore } from '@einfach/core'
import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithStore } from '../test/renderWithStore'
import { MessageList } from './MessageList'
import {
  activeSessionIdAtom,
  addBrowserCard,
  appendMessage,
  createId,
  runsBySessionAtom,
} from '../agent/state/atoms'
import * as loop from '../agent/runtime/loop'

function seedCard(store: ReturnType<typeof createStore>, createdAt: number) {
  const sessionId = store.getter(activeSessionIdAtom)
  return addBrowserCard(store, sessionId, {
    id: createId('card'),
    createdAt,
    title: '部署方案对比',
    body: '**重点**：稳定性优先',
    items: ['方案 A', '方案 B'],
    options: ['选 A', '选 B'],
  })
}

describe('BrowserActionCard in MessageList', () => {
  it('renders title, markdown body, items and option buttons inside the transcript', () => {
    const store = createStore()
    seedCard(store, 1000)

    renderWithStore(<MessageList />, { store })

    expect(screen.getByText('部署方案对比')).toBeInTheDocument()
    expect(screen.getByText('重点')).toBeInTheDocument() // markdown <strong>
    expect(screen.getByText('方案 A')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '选 A' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '选 B' })).toBeInTheDocument()
  })

  it('merges cards with messages by createdAt (card appears in chronological order)', () => {
    const store = createStore()
    const sessionId = store.getter(activeSessionIdAtom)
    appendMessage(store, sessionId, { id: 'm1', role: 'user', content: '早消息', createdAt: 100 })
    seedCard(store, 500)
    appendMessage(store, sessionId, { id: 'm2', role: 'assistant', content: '晚消息', createdAt: 900 })

    renderWithStore(<MessageList />, { store })

    const transcript = screen.getByLabelText('对话记录')
    const text = transcript.textContent ?? ''
    const idxEarly = text.indexOf('早消息')
    const idxCard = text.indexOf('部署方案对比')
    const idxLate = text.indexOf('晚消息')
    expect(idxEarly).toBeGreaterThanOrEqual(0)
    expect(idxCard).toBeGreaterThan(idxEarly)
    expect(idxLate).toBeGreaterThan(idxCard)
  })

  it('BF5: on equal createdAt, items keep true insertion order (card between two same-timestamp messages)', () => {
    const store = createStore()
    const sessionId = store.getter(activeSessionIdAtom)
    // all share the same createdAt — sort must fall back to real append order.
    appendMessage(store, sessionId, { id: 'm1', role: 'user', content: '先发的消息', createdAt: 1000 })
    seedCard(store, 1000)
    appendMessage(store, sessionId, { id: 'm2', role: 'assistant', content: '后发的消息', createdAt: 1000 })

    renderWithStore(<MessageList />, { store })

    const text = screen.getByLabelText('对话记录').textContent ?? ''
    const idxFirst = text.indexOf('先发的消息')
    const idxCard = text.indexOf('部署方案对比')
    const idxLast = text.indexOf('后发的消息')
    expect(idxFirst).toBeGreaterThanOrEqual(0)
    expect(idxCard).toBeGreaterThan(idxFirst)
    expect(idxLast).toBeGreaterThan(idxCard)
  })

  it('option button is disabled while the run is busy (no silent abort)', () => {
    const store = createStore()
    const sessionId = store.getter(activeSessionIdAtom)
    store.setter(runsBySessionAtom, (prev) => ({
      ...prev,
      [sessionId]: { id: 'run-1', sessionId, status: 'running', input: 'x', loadedSkills: [], loadedTools: [] },
    }))
    seedCard(store, 1000)

    renderWithStore(<MessageList />, { store })

    expect(screen.getByRole('button', { name: '选 A' })).toBeDisabled()
  })

  it('BF6: clicking an option starts a new run with structured text carrying title + option + card context (body/items)', () => {
    const store = createStore()
    seedCard(store, 1000)
    const spy = vi.spyOn(loop, 'startAgentRun').mockImplementation(() => {})

    renderWithStore(<MessageList />, { store })
    fireEvent.click(screen.getByRole('button', { name: '选 A' }))

    expect(spy).toHaveBeenCalledTimes(1)
    const text = spy.mock.calls[0][1]
    expect(text).toContain('部署方案对比') // title
    expect(text).toContain('选 A') // chosen option
    // BF6: extra context so the model isn't left with only a generic title.
    expect(text).toContain('方案 A') // items summary
    spy.mockRestore()
  })

  it('BG5: option prompt folds in body + items + options, each bounded (no unbounded blow-up)', () => {
    const store = createStore()
    const sessionId = store.getter(activeSessionIdAtom)
    const longBody = 'x'.repeat(500)
    const manyItems = Array.from({ length: 25 }, (_, i) => `条目${i + 1}`)
    const manyOptions = Array.from({ length: 25 }, (_, i) => `选项${i + 1}`)
    addBrowserCard(store, sessionId, {
      id: createId('card'),
      createdAt: 1000,
      title: '大卡片',
      body: longBody,
      items: manyItems,
      options: manyOptions,
    })
    const spy = vi.spyOn(loop, 'startAgentRun').mockImplementation(() => {})

    renderWithStore(<MessageList />, { store })
    fireEvent.click(screen.getByRole('button', { name: '选项1' }))

    const text = spy.mock.calls[0][1]
    // all three sections present
    expect(text).toContain('卡片正文:')
    expect(text).toContain('卡片条目:')
    expect(text).toContain('全部可选项:')
    expect(text).toContain('条目1')
    expect(text).toContain('选项1')
    // body clipped (500 -> <=200 + ellipsis), and list heads truncated with a
    // "等25项" marker rather than dumping all 25 entries.
    expect(text).toContain('…')
    expect(text).toContain('等25项')
    expect(text).not.toContain('条目25')
    expect(text).not.toContain('选项25')
    // the full body must not appear verbatim
    expect(text).not.toContain(longBody)
    spy.mockRestore()
  })
})
