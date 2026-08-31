import { act, fireEvent, screen } from '@testing-library/react'
import { createStore } from '@einfach/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  activeSessionIdAtom,
  defaultCore,
  rootStore,
  runAtom,
  sessionsAtom,
  type ModelSettings,
  type SessionMeta,
} from '@einfach-agent/core'
import { renderWithStore } from '../../test/renderWithStore'
import { setModelConnectionProfiles } from '../../settings/modelConnectionProfileState'
import type { ModelConnectionProfile } from '../../settings/modelConnectionProfileHost'
import { ActiveSessionProvider } from './ActiveSessionProvider'
import { Composer } from './Composer'

function session(id: string, settings: ModelSettings): SessionMeta {
  return { id, title: id, settings, createdAt: 1, updatedAt: 1 }
}

function profile(): ModelConnectionProfile {
  return {
    id: 'team/profile',
    label: '团队网关',
    kind: 'openai-compatible',
    baseUrl: 'https://secret-endpoint.example/v1',
    credentialConfigured: true,
    models: [{ id: 'reasoning/model', label: '团队推理', source: 'manual' }],
  }
}

function seedSessions() {
  rootStore.setter(sessionsAtom, {
    a: session('a', {
      vendor: 'deepseek', model: 'deepseek-v4-pro', thinking: true,
      vendorSettings: { reasoning_effort: 'high' },
    }),
    b: session('b', {
      vendor: 'glm', model: 'glm-5.2', thinking: true,
      vendorSettings: { reasoning_effort: 'medium' },
    }),
  })
  rootStore.setter(activeSessionIdAtom, 'a')
}

function renderActiveComposer() {
  const store = createStore()
  setModelConnectionProfiles(store, [profile()])
  return renderWithStore(
    <ActiveSessionProvider><Composer /></ActiveSessionProvider>,
    { store },
  )
}

describe('Composer model controls integration', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('经真实 command 更新当前会话，profile identity 与会话隔离不丢', () => {
    seedSessions()
    const persist = vi.spyOn(defaultCore.persistence, 'persistSessions').mockImplementation(() => undefined)
    renderActiveComposer()

    fireEvent.click(screen.getByRole('radio', { name: 'Max' }))
    expect(rootStore.getter(sessionsAtom).a.settings.vendorSettings?.reasoning_effort).toBe('max')

    const profileOption = screen.getByRole('option', { name: '团队推理' }) as HTMLOptionElement
    fireEvent.change(screen.getByRole('combobox', { name: '模型' }), {
      target: { value: profileOption.value },
    })
    expect(rootStore.getter(sessionsAtom).a.settings).toEqual({
      vendor: 'openai-compat', model: 'reasoning/model',
      vendorSettings: { connectionId: 'team/profile' },
    })
    expect(rootStore.getter(sessionsAtom).b.settings).toEqual({
      vendor: 'glm', model: 'glm-5.2', thinking: true,
      vendorSettings: { reasoning_effort: 'medium' },
    })
    expect(screen.getByRole('button', { name: '当前模型的 Thinking 能力未知' })).toBeDisabled()

    act(() => rootStore.setter(activeSessionIdAtom, 'b'))
    expect((screen.getByRole('option', { name: 'GLM-5.2' }) as HTMLOptionElement).selected).toBe(true)
    expect(screen.getByRole('radio', { name: 'Medium' })).toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'Thinking 已开启，点击关闭' }))

    expect(rootStore.getter(sessionsAtom).b.settings.thinking).toBe(false)
    expect(rootStore.getter(sessionsAtom).a.settings.vendorSettings).toEqual({
      connectionId: 'team/profile',
    })
    expect(persist).toHaveBeenCalledTimes(3)
  })

  it.each([
    ['effort', { vendor: 'deepseek', model: 'deepseek-v4-pro' }],
    ['toggle-only', { vendor: 'kimi', model: 'kimi-k2.6' }],
  ] as const)('%s 模型缺省 thinking 使用 provider On，首次点击写 false', (_, settings) => {
    rootStore.setter(sessionsAtom, { a: session('a', settings) })
    rootStore.setter(activeSessionIdAtom, 'a')
    const persist = vi.spyOn(defaultCore.persistence, 'persistSessions').mockImplementation(() => undefined)
    renderActiveComposer()

    const toggle = screen.getByRole('button', { name: 'Thinking 已开启，点击关闭' })
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(toggle)

    expect(rootStore.getter(sessionsAtom).a.settings).toEqual({ ...settings, thinking: false })
    expect(persist).toHaveBeenCalledOnce()
  })

  it('所有非终态 run 禁用控件，终态恢复操作', () => {
    seedSessions()
    vi.spyOn(defaultCore.persistence, 'persistSessions').mockImplementation(() => undefined)
    renderActiveComposer()
    const agentStore = defaultCore.getSessionStore('a').store
    const busyStatuses = [
      'running', 'awaiting_tool', 'waiting_user', 'waiting_confirmation',
      'waiting_plan_approval', 'interrupted',
    ] as const

    for (const status of busyStatuses) {
      act(() => agentStore.setter(runAtom, { runId: `run-${status}`, status }))
      expect(screen.getByRole('combobox', { name: '模型' })).toBeDisabled()
      expect(screen.getByRole('button', { name: /Thinking/ })).toBeDisabled()
    }

    for (const status of ['idle', 'done', 'stopped', 'error'] as const) {
      act(() => agentStore.setter(runAtom, { runId: `run-${status}`, status }))
      expect(screen.getByRole('combobox', { name: '模型' })).toBeEnabled()
      expect(screen.getByRole('button', { name: /Thinking/ })).toBeEnabled()
    }
  })
})
