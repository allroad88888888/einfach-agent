import { createStore } from '@einfach/core'
import {
  activeSessionIdAtom,
  itemsAtom,
  runAtom,
  sessionsAtom,
  type ConversationItem,
} from '@einfach-agent/core'
import { cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { activateLocale, appI18n } from '../../i18n'
import { LOCALE_STORAGE_KEY } from '../../i18n/localeStorage'
import { renderWithStore } from '../../test/renderWithStore'
import { Composer } from './Composer'
import { MessageList } from './MessageList'
import { SessionList } from './SessionList'
import { ToolConfirmCard } from './ToolConfirmCard'

let storedLocale: string | null
let storedDocumentLanguage: string

function restoreStoredLocale(): void {
  if (storedLocale === null) {
    window.localStorage.removeItem(LOCALE_STORAGE_KEY)
    return
  }
  window.localStorage.setItem(LOCALE_STORAGE_KEY, storedLocale)
}

function renderConversationSurface(): void {
  const rootStore = createStore()
  rootStore.setter(sessionsAtom, {
    'conversation-fixture': {
      id: 'conversation-fixture',
      title: 'Release notes fixture',
      settings: { vendor: 'fixture-vendor', model: 'fixture-model' },
      createdAt: 1,
      updatedAt: 1,
    },
  })
  rootStore.setter(activeSessionIdAtom, 'conversation-fixture')

  const agentStore = createStore()
  const items: ConversationItem[] = [
    {
      id: 'assistant-fixture',
      createdAt: 1,
      item: {
        role: 'assistant',
        content: null,
        reasoning_content: 'Fixture reasoning supplied by the model.',
        tool_calls: [{
          id: 'tool-call-fixture',
          type: 'function',
          function: { name: 'fixture_read', arguments: '{"path":"fixture.txt"}' },
        }],
      },
    },
  ]
  agentStore.setter(itemsAtom, items)
  agentStore.setter(runAtom, {
    runId: 'run-fixture',
    status: 'waiting_confirmation',
    pendingToolConfirmation: {
      callId: 'confirmation-fixture',
      toolName: 'fixture_write',
      args: { path: 'fixture.txt' },
    },
  })

  renderWithStore(
    <>
      <SessionList />
      <MessageList />
      <Composer />
      <ToolConfirmCard />
    </>,
    { rootStore, agentStore },
  )
}

describe('conversation i18n', () => {
  beforeEach(async () => {
    storedLocale = window.localStorage.getItem(LOCALE_STORAGE_KEY)
    storedDocumentLanguage = document.documentElement.lang
    await activateLocale('zh-CN')
    document.documentElement.lang = 'zh-CN'
  })

  afterEach(async () => {
    cleanup()
    await activateLocale('zh-CN')
    restoreStoredLocale()
    document.documentElement.lang = storedDocumentLanguage
  })

  it('keeps Chinese as the initial conversation locale', () => {
    renderConversationSurface()

    expect(appI18n.locale).toBe('zh-CN')
    expect(document.documentElement.lang).toBe('zh-CN')
    expect(screen.getByRole('button', { name: '删除' })).toBeInTheDocument()
    expect(screen.getByText('思考过程')).toBeInTheDocument()
    expect(screen.getByText('模型思考')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: '消息' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '发送' })).toBeInTheDocument()
    expect(screen.getByText('需要确认')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '允许' })).toBeInTheDocument()
  })

  it('renders migrated conversation chrome from the real English catalog', async () => {
    await activateLocale('en')
    renderConversationSurface()

    expect(appI18n.locale).toBe('en')
    expect(document.documentElement.lang).toBe('en')

    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
    fireEvent.doubleClick(screen.getByText('Release notes fixture'))
    expect(screen.getByRole('textbox', { name: 'Rename conversation' })).toBeInTheDocument()

    expect(screen.getByText('Reasoning')).toBeInTheDocument()
    expect(screen.getByText('Model reasoning')).toBeInTheDocument()
    expect(screen.getByText('Fixture reasoning supplied by the model.')).toBeInTheDocument()
    expect(screen.getByText(/fixture_read/)).toHaveTextContent('fixture_read')
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Approval mode: Confirm/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument()

    expect(screen.getByText('Confirmation required')).toBeInTheDocument()
    expect(screen.getByText(/About to run tool/)).toBeInTheDocument()
    expect(screen.getByText('fixture_write')).toBeInTheDocument()
    expect(screen.getByLabelText('Tool argument preview')).toHaveTextContent('fixture.txt')
    expect(screen.getByText('Always allow this tool for this session')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Allow' })).toBeInTheDocument()
  })
})
