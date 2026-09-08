import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { useRef } from 'react'
import { describe, expect, it } from 'vitest'
import {
  activeSessionIdAtom,
  defaultCore,
  rootStore,
  sessionCapabilityPolicyVersion,
  sessionsAtom,
  type SessionMeta,
} from '@einfach-agent/core'
import { renderWithStore } from '../../test/renderWithStore'
import { ActiveSessionProvider, useActiveSessionConfig } from './ActiveSessionProvider'
import { ConversationCapabilitiesPanel } from './ConversationCapabilitiesPanel'

function session(): SessionMeta {
  return {
    id: 'session-a', title: 'Draft', createdAt: 1, updatedAt: 1,
    settings: { vendor: 'mock', model: 'mock' },
    capabilityPolicy: { version: 1, state: 'draft', revision: 0, disabledTools: [], disabledSkills: [] },
  }
}

function ActivePanel() {
  const active = useActiveSessionConfig()!
  const triggerRef = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button ref={triggerRef} type="button">能力</button>
      <ConversationCapabilitiesPanel
        open
        sessionId={active.id}
        policyVersion={sessionCapabilityPolicyVersion(active.capabilityPolicy)}
        policyState={active.capabilityPolicy?.state ?? 'legacy-unrestricted'}
        triggerRef={triggerRef}
        onClose={() => undefined}
      />
    </>
  )
}

describe('ConversationCapabilitiesPanel locked transition', () => {
  it('用真实 010 命令顺序清空多个工具，不留下 revision 竞态的部分更新', async () => {
    rootStore.setter(sessionsAtom, { 'session-a': session() })
    rootStore.setter(activeSessionIdAtom, 'session-a')
    defaultCore.createSessionStore('session-a')
    renderWithStore(<ActiveSessionProvider><ActivePanel /></ActiveSessionProvider>)

    await screen.findByText('首次发送前可编辑此对话的能力。')
    const toolSection = screen.getByRole('heading', { name: '工具' }).closest('section')!
    const selected = within(toolSection).getAllByRole<HTMLInputElement>('checkbox')
      .filter((input) => !input.disabled && input.checked)
    expect(selected.length).toBeGreaterThanOrEqual(2)
    const names = selected.slice(0, 2).map((input) => input.getAttribute('aria-label')!.replace('切换 ', ''))

    fireEvent.click(within(toolSection).getByRole('button', { name: '清空' }))
    await waitFor(() => {
      for (const input of selected.slice(0, 2)) expect(input).not.toBeChecked()
    })
    const policy = rootStore.getter(sessionsAtom)['session-a'].capabilityPolicy
    expect(policy?.state).toBe('draft')
    if (policy?.state === 'draft') expect(policy.disabledTools).toEqual(expect.arrayContaining(names))
  })

  it('provider 收到首发锁定后的 meta 更新时，已打开面板立即只读', async () => {
    rootStore.setter(sessionsAtom, { 'session-a': session() })
    rootStore.setter(activeSessionIdAtom, 'session-a')
    defaultCore.createSessionStore('session-a')
    renderWithStore(<ActiveSessionProvider><ActivePanel /></ActiveSessionProvider>)

    expect(await screen.findByText('首次发送前可编辑此对话的能力。')).toBeInTheDocument()
    act(() => {
      rootStore.setter(sessionsAtom, (sessions) => ({
        ...sessions,
        'session-a': {
          ...sessions['session-a'],
          capabilityPolicy: {
            version: 1, state: 'locked', revision: 1, allowedTools: [], allowedSkills: [], lockedAt: 2,
          },
        },
      }))
    })

    expect(await screen.findByText('配置在发送首条消息后锁定。')).toBeInTheDocument()
    await waitFor(() => expect(screen.getAllByRole('checkbox')[0]).toBeDisabled())
  })
})
