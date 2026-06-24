import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import {
  activeMessagesAtom,
  activeRunAtom,
  activeTimelineAtom,
  composerDraftAtom,
} from '../agent/state/atoms'
import { renderWithStore } from '../test/renderWithStore'
import { Composer } from './Composer'

describe('Composer', () => {
  it('sends the controlled draft through the agent runtime', async () => {
    const user = userEvent.setup()
    const { store } = renderWithStore(<Composer />)

    await user.type(screen.getByPlaceholderText('输入任务'), '做一个 web agent 的执行方案')
    expect(screen.getByRole('button', { name: '发送' })).toBeEnabled()

    await user.click(screen.getByRole('button', { name: '发送' }))

    await waitFor(() => expect(store.getter(activeRunAtom)?.status).toBe('done'), {
      timeout: 5000,
    })

    expect(store.getter(composerDraftAtom)).toBe('')
    expect(store.getter(activeMessagesAtom).some((message) => message.content.includes('web agent'))).toBe(true)
    expect(store.getter(activeTimelineAtom).some((event) => event.title === 'MainArchitectAgent')).toBe(true)
  })

  it('keeps the send button disabled for empty drafts', () => {
    renderWithStore(<Composer />)

    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '停止' })).toBeDisabled()
  })
})
