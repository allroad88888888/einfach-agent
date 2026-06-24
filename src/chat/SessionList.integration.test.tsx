import { createStore } from '@einfach/core'
import { Provider } from '@einfach/react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { ChatShell } from './ChatShell'
import {
  activeSessionIdAtom,
  createSession,
  messagesBySessionAtom,
  runsBySessionAtom,
  sessionsAtom,
  timelineBySessionAtom,
} from '../agent/state/atoms'
import { startAgentRun } from '../agent/runtime/loop'

function sessionListItem(sessionTitle: string) {
  const list = screen.getByRole('complementary', { name: '会话列表' })
  return within(list).getByText(sessionTitle).closest('li')!
}

describe('RF1 deleting the active session does not crash ChatShell', () => {
  it('keeps rendering through deletion of the active session', async () => {
    const store = createStore()
    const original = store.getter(activeSessionIdAtom)
    createSession(store, '第二个会话')
    store.setter(activeSessionIdAtom, original)

    render(
      <Provider store={store}>
        <ChatShell />
      </Provider>,
    )

    const firstTitle = store.getter(sessionsAtom)[original].title
    const item = sessionListItem(firstTitle)
    // Deleting the active session must not throw a render error mid-publish.
    await userEvent.click(within(item).getByRole('button', { name: /^删除/ }))

    expect(store.getter(activeSessionIdAtom)).not.toBe(original)
    expect(screen.getByRole('heading', { name: '第二个会话' })).toBeInTheDocument()
  })

  it('rebuilds a default session when the last one is deleted, without crashing', async () => {
    const store = createStore()
    const only = store.getter(activeSessionIdAtom)
    const title = store.getter(sessionsAtom)[only].title

    render(
      <Provider store={store}>
        <ChatShell />
      </Provider>,
    )

    const item = sessionListItem(title)
    await userEvent.click(within(item).getByRole('button', { name: /^删除/ }))

    expect(Object.keys(store.getter(sessionsAtom))).toHaveLength(1)
    expect(store.getter(activeSessionIdAtom)).not.toBe(only)
    // Shell still rendered a session header (no crash from undefined active session).
    expect(screen.getAllByRole('heading').length).toBeGreaterThan(0)
  })
})

describe('RF2 deleting a session cancels its in-flight run', () => {
  it('aborts the run and leaves no ghost session/messages/timeline', async () => {
    const store = createStore()
    const target = store.getter(activeSessionIdAtom)
    createSession(store, '其它会话')
    store.setter(activeSessionIdAtom, target)

    startAgentRun(store, '做一个 web agent 的执行方案，包含lazy tools')
    await waitFor(() => expect(store.getter(runsBySessionAtom)[target]?.status).toBe('running'))

    render(
      <Provider store={store}>
        <ChatShell />
      </Provider>,
    )

    const targetTitle = store.getter(sessionsAtom)[target].title
    const item = sessionListItem(targetTitle)
    await userEvent.click(within(item).getByRole('button', { name: /^删除/ }))

    expect(store.getter(sessionsAtom)[target]).toBeUndefined()
    expect(store.getter(runsBySessionAtom)[target]).toBeUndefined()
    expect(store.getter(messagesBySessionAtom)[target]).toBeUndefined()
    expect(store.getter(timelineBySessionAtom)[target]).toBeUndefined()

    // Give the aborted run a window to (incorrectly) write back — it must not.
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(store.getter(sessionsAtom)[target]).toBeUndefined()
    expect(store.getter(runsBySessionAtom)[target]).toBeUndefined()
    expect(store.getter(messagesBySessionAtom)[target]).toBeUndefined()
    expect(store.getter(timelineBySessionAtom)[target]).toBeUndefined()

    // The surviving active session is valid.
    const activeId = store.getter(activeSessionIdAtom)
    expect(store.getter(sessionsAtom)[activeId]).toBeDefined()
  })
})
