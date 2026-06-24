import { screen } from '@testing-library/react'
import { createStore } from '@einfach/core'
import { describe, expect, it } from 'vitest'
import { activeSessionIdAtom, appendTimelineEvent } from '../agent/state/atoms'
import { renderWithStore } from '../test/renderWithStore'
import { ToolTimeline } from './ToolTimeline'

describe('ToolTimeline', () => {
  it('renders an empty state before a run starts', () => {
    renderWithStore(<ToolTimeline />)

    expect(screen.getByText('暂无事件')).toBeInTheDocument()
  })

  it('renders timeline events from the Einfach store', () => {
    const store = createStore()
    const sessionId = store.getter(activeSessionIdAtom)

    appendTimelineEvent(store, sessionId, {
      id: 'event-agent',
      runId: 'run-test',
      kind: 'agent',
      title: 'MainArchitectAgent',
      detail: 'Planning worker tasks.',
      status: 'done',
      timestamp: 1,
    })
    appendTimelineEvent(store, sessionId, {
      id: 'event-tool',
      runId: 'run-test',
      kind: 'tool',
      title: 'load delegate_agent',
      detail: 'internal schema loaded.',
      status: 'done',
      timestamp: 2,
    })

    renderWithStore(<ToolTimeline />, { store })

    expect(screen.getByRole('heading', { name: 'MainArchitectAgent' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'load delegate_agent' })).toBeInTheDocument()
    expect(screen.getByText('internal schema loaded.')).toBeInTheDocument()
  })
})
