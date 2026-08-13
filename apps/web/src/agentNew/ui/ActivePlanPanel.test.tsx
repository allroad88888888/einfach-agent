import { createStore } from '@einfach/core'
import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { planAtom } from '@web-agent/core'
import { renderWithStore } from '../../test/renderWithStore'
import { ActivePlanPanel } from './ActivePlanPanel'

describe('ActivePlanPanel', () => {
  it('keeps a completed plan out of the fixed action surface', () => {
    const store = createStore()
    store.setter(planAtom, {
      id: 'completed-plan', title: '已完成交付', objective: '归档结果', status: 'completed', revision: 1,
      requiresApproval: false, createdAt: 1, updatedAt: 2, stages: [],
    })

    const { container } = renderWithStore(<ActivePlanPanel />, { store })

    expect(container).toBeEmptyDOMElement()
  })

  it('keeps an actionable plan in the fixed action surface', () => {
    const store = createStore()
    store.setter(planAtom, {
      id: 'active-plan', title: '正在执行', objective: '完成交付', status: 'active', revision: 1,
      requiresApproval: false, createdAt: 1, updatedAt: 2,
      stages: [{
        id: 'work', title: '实施', objective: '写代码', deliverables: [], dependencies: [],
        status: 'in_progress', evidence: [],
      }],
    })

    renderWithStore(<ActivePlanPanel />, { store })

    expect(screen.getByRole('heading', { name: '正在执行' })).toBeInTheDocument()
  })
})
