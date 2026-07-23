import { describe, it, expect, afterEach } from 'vitest'
import { screen } from '@testing-library/react'
import { createStore } from '@einfach/core'
import { renderWithStore } from '../../test/renderWithStore'
import { toolActivityAtom } from '@web-agent/core/state/transientAtoms'
import { ToolActivity } from './ToolActivity'

describe('ToolActivity', () => {
  afterEach(() => {})

  it('空进度 → 渲染为空（null）', () => {
    const { container } = renderWithStore(<ToolActivity />, { store: createStore() })
    expect(container.firstChild).toBeNull()
  })

  it('有进度 → 渲染各工具名 + 文案', () => {
    const store = createStore()
    store.setter(toolActivityAtom, [
      { callId: 'c1', toolName: 'skill_search', text: '正在搜索…' },
      { callId: 'c2', toolName: 'save_file', text: '写入中' },
    ])
    renderWithStore(<ToolActivity />, { store })

    expect(screen.getByText('skill_search')).toBeInTheDocument()
    expect(screen.getByText('正在搜索…')).toBeInTheDocument()
    expect(screen.getByText('save_file')).toBeInTheDocument()
    expect(screen.getByText('写入中')).toBeInTheDocument()
  })
})
