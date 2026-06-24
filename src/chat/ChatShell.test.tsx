import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { renderWithStore } from '../test/renderWithStore'
import { ChatShell } from './ChatShell'

describe('ChatShell', () => {
  it('renders the initial chat workbench', () => {
    renderWithStore(<ChatShell />)

    expect(screen.getByRole('heading', { name: 'Web Agent' })).toBeInTheDocument()
    expect(screen.getByText('浏览器运行时 · Einfach 状态 · ai-components 渲染')).toBeInTheDocument()
    expect(screen.getByText('运行过程')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('输入任务')).toBeInTheDocument()
    expect(screen.getByText(/Web Agent 已就绪/)).toBeInTheDocument()
  })
})
