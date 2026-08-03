import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { BrowserCard } from '@web-agent/core/state/transientAtoms'
import { BrowserActionCard } from './BrowserActionCard'

// P8-e BrowserActionCard：纯展示卡片（新 BrowserCard 只有 title + 可选 body）。
// 渲染 title；有 body 走 react-markdown，无 body 不渲染正文区。无按钮、无 atom。

describe('BrowserActionCard', () => {
  it('无 body：渲染 title，不渲染正文区', () => {
    const card: BrowserCard = { id: 'c1', createdAt: 1, title: '标题X' }

    const { container } = render(<BrowserActionCard card={card} />)

    // 标题在
    expect(screen.getByText('标题X')).toBeInTheDocument()
    // 没有正文区
    expect(container.querySelector('.agentnew-browser-card-body')).toBeNull()
  })

  it('有 body：markdown 渲染出正文文本', async () => {
    const card: BrowserCard = { id: 'c2', createdAt: 2, title: '标题Y', body: '**粗体**正文' }

    const { container } = render(<BrowserActionCard card={card} />)

    // 标题在
    expect(screen.getByText('标题Y')).toBeInTheDocument()
    // 正文区在
    expect(container.querySelector('.agentnew-browser-card-body')).not.toBeNull()
    // markdown 已转：**粗体** → <strong>粗体</strong>
    const strong = await screen.findByText('粗体')
    expect(strong).toBeInTheDocument()
    expect(strong.tagName).toBe('STRONG')
    // 正文其余文本也在
    expect(screen.getByText(/正文/)).toBeInTheDocument()
  })
})
