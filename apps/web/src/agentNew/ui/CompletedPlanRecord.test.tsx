import { createStore } from '@einfach/core'
import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { planAtom } from '@einfach-agent/core'
import { renderWithStore } from '../../test/renderWithStore'
import { CompletedPlanRecord } from './CompletedPlanRecord'

describe('CompletedPlanRecord', () => {
  it('does not render before the plan is completed', () => {
    const store = createStore()
    store.setter(planAtom, {
      id: 'active-plan', title: '正在执行', objective: '完成交付', status: 'active', revision: 1,
      requiresApproval: false, createdAt: 1, updatedAt: 2, stages: [],
    })

    const { container } = renderWithStore(<CompletedPlanRecord />, { agentStore: store })

    expect(container).toBeEmptyDOMElement()
  })

  it('starts compact and reveals results only when requested', () => {
    const store = createStore()
    store.setter(planAtom, {
      id: 'completed-plan', title: '优化缓存命中', objective: '稳定提高缓存复用', status: 'completed', revision: 3,
      requiresApproval: false, createdAt: 1, updatedAt: 2,
      stages: [{
        id: 'verify', title: '验证改动', objective: '运行验证', deliverables: ['测试报告'], dependencies: [],
        status: 'completed', evidence: ['111 tests passed'],
        result: { summary: '验证全部通过', evidence: ['111 tests passed'], submittedAt: 2 },
      }],
    })

    renderWithStore(<CompletedPlanRecord />, { agentStore: store })

    expect(screen.getByText('计划记录')).toBeInTheDocument()
    expect(screen.getByText('1/1 阶段完成')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '查看计划记录' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('验证改动', { selector: 'summary strong' })).toBeNull()
    expect(screen.queryByText('验证全部通过')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '查看计划记录' }))

    expect(screen.getByRole('button', { name: '收起计划记录' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('验证改动', { selector: 'summary strong' })).toBeInTheDocument()
    expect(screen.queryByText('验证全部通过')).toBeNull()

    fireEvent.click(screen.getByText('验证改动', { selector: 'summary strong' }))

    expect(screen.getByText('验证全部通过')).toBeInTheDocument()
    expect(screen.getByText('证据：111 tests passed')).toBeInTheDocument()
  })
})
