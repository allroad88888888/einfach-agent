import { createStore } from '@einfach/core'
import { Provider } from '@einfach/react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { SessionList } from './SessionList'
import {
  activeSessionIdAtom,
  createSession,
  sessionsAtom,
} from '../agent/state/atoms'

function renderWithStore(store = createStore()) {
  return {
    store,
    ...render(
      <Provider store={store}>
        <SessionList />
      </Provider>,
    ),
  }
}

describe('SessionList', () => {
  it('renders existing sessions', () => {
    const store = createStore()
    renderWithStore(store)
    const activeId = store.getter(activeSessionIdAtom)
    const title = store.getter(sessionsAtom)[activeId].title
    expect(screen.getByText(title)).toBeInTheDocument()
  })

  it('creates a new session when the new button is clicked', async () => {
    const store = createStore()
    renderWithStore(store)
    const before = Object.keys(store.getter(sessionsAtom)).length

    await userEvent.click(screen.getByRole('button', { name: /新建会话/ }))

    expect(Object.keys(store.getter(sessionsAtom))).toHaveLength(before + 1)
  })

  it('switches the active session on click', async () => {
    const store = createStore()
    const other = createSession(store, '第二个会话')
    const original = Object.keys(store.getter(sessionsAtom)).find((id) => id !== other)!
    store.setter(activeSessionIdAtom, original)

    renderWithStore(store)

    await userEvent.click(screen.getByText('第二个会话'))
    expect(store.getter(activeSessionIdAtom)).toBe(other)
  })

  it('deletes a session via its delete control', async () => {
    const store = createStore()
    const other = createSession(store, '临时会话')

    renderWithStore(store)

    const item = screen.getByText('临时会话').closest('li')!
    await userEvent.click(within(item).getByRole('button', { name: /^删除/ }))

    expect(store.getter(sessionsAtom)[other]).toBeUndefined()
  })
})
