import { screen } from '@testing-library/react'
import { createStore } from '@einfach/core'
import { describe, expect, it } from 'vitest'
import { activeSessionIdAtom, appendTimelineEvent, setRunState } from '../agent/state/atoms'
import { renderWithStore } from '../test/renderWithStore'
import { RunActivity } from './RunActivity'

describe('RunActivity', () => {
  it('renders compact live run progress from the Einfach timeline', () => {
    const store = createStore()
    const sessionId = store.getter(activeSessionIdAtom)

    setRunState(store, sessionId, {
      id: 'run-test',
      sessionId,
      status: 'running',
      input: '规划 web agent',
      loadedSkills: [],
      loadedTools: [],
    })
    appendTimelineEvent(store, sessionId, {
      id: 'event-model',
      runId: 'run-test',
      kind: 'model',
      title: 'ModelAgentTurn',
      detail: '思考：需要先判断是否要加载 ask_user_question',
      status: 'running',
      timestamp: 1,
    })

    renderWithStore(<RunActivity />, { store })

    expect(screen.getByRole('heading', { name: '执行中' })).toBeInTheDocument()
    expect(screen.getAllByText('思考')).toHaveLength(2)
    expect(screen.getByText('ModelAgentTurn')).toBeInTheDocument()
    expect(screen.getByText('思考：需要先判断是否要加载 ask_user_question')).toBeInTheDocument()
  })

  it('stays hidden when there is no active run', () => {
    const { container } = renderWithStore(<RunActivity />)

    expect(container).toBeEmptyDOMElement()
  })
})
