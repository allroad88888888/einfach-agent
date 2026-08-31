import { fireEvent, screen } from '@testing-library/react'
import { createStore } from '@einfach/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  activeSessionIdAtom,
  defaultCore,
  rootStore,
  sessionsAtom,
  type SessionMeta,
} from '@einfach-agent/core'
import { renderWithStore } from '../../test/renderWithStore'
import { ActiveSessionProvider } from './ActiveSessionProvider'
import { Composer } from './Composer'

function defaultSession(vendor: string, model: string): SessionMeta {
  return {
    id: `default-${vendor}`,
    title: `Default ${vendor}`,
    settings: { vendor, model },
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('Composer model controls audit', () => {
  afterEach(() => vi.restoreAllMocks())

  it.each([
    ['DeepSeek', 'deepseek', 'deepseek-v4-pro'],
    ['GLM-5.3', 'glm', 'glm-5.3'],
  ] as const)('makes a %s effort selected from provider-default On effective', (_, vendor, model) => {
    const seeded = defaultSession(vendor, model)
    rootStore.setter(sessionsAtom, { [seeded.id]: seeded })
    rootStore.setter(activeSessionIdAtom, seeded.id)
    vi.spyOn(defaultCore.persistence, 'persistSessions').mockImplementation(() => undefined)

    renderWithStore(
      <ActiveSessionProvider><Composer /></ActiveSessionProvider>,
      { store: createStore() },
    )

    expect(screen.getByRole('button', { name: vendor === 'glm' ? 'Thinking 始终开启' : 'Thinking 已开启，点击关闭' }))
      .toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('radio', { name: 'Max' }))

    expect(rootStore.getter(sessionsAtom)[seeded.id]?.settings).toEqual({
      vendor,
      model,
      thinking: true,
      vendorSettings: { reasoning_effort: 'max' },
    })
  })
})
