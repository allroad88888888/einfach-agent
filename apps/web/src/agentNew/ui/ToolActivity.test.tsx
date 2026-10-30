import { describe, it, expect, afterEach } from 'vitest'
import { screen, act } from '@testing-library/react'
import { createStore } from '@einfach/core'
import { renderWithStore } from '../../test/renderWithStore'
import { toolActivityAtom } from '@einfach-agent/core'
import { ToolActivity } from './ToolActivity'

describe('ToolActivity', () => {
  afterEach(() => {})

  it('空进度 → 渲染为空（null）', () => {
    const { container } = renderWithStore(<ToolActivity />, { agentStore: createStore() })
    expect(container.firstChild).toBeNull()
  })

  it('有进度 → 渲染各工具名 + 文案', () => {
    const store = createStore()
    store.setter(toolActivityAtom, [
      { callId: 'c1', toolName: 'skill_search', text: '正在搜索…' },
      { callId: 'c2', toolName: 'save_file', text: '写入中' },
    ])
    renderWithStore(<ToolActivity />, { agentStore: store })

    expect(screen.getByText('skill_search')).toBeInTheDocument()
    expect(screen.getByText('正在搜索…')).toBeInTheDocument()
    expect(screen.getByText('save_file')).toBeInTheDocument()
    expect(screen.getByText('写入中')).toBeInTheDocument()
  })
  it('renders live text safely and removes it when its call ends', () => {
    const store = createStore()
    store.setter(toolActivityAtom, [{ callId: 'a', toolName: 'shell', text: 'running' }])
    renderWithStore(<ToolActivity />, { agentStore: store })
    act(() => store.setter(toolActivityAtom, [{ callId: 'a', toolName: 'shell', text: 'running', output: '<script>secret</script>\nstdout\nstderr' }]))
    expect(screen.getByLabelText('Shell 实时输出').textContent).toBe('<script>secret</script>\nstdout\nstderr')
    expect(document.querySelector('script')).toBeNull()
    act(() => store.setter(toolActivityAtom, []))
    expect(screen.queryByLabelText('Shell 实时输出')).toBeNull()
  })

})
