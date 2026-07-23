import { createStore } from '@einfach/core'
import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithStore } from '../../test/renderWithStore'
import { planAtom, runAtom } from '@web-agent/core/state/sessionAtoms'
import { acceptPlanResult, approvePlan } from '@web-agent/core/runtime/commands'
import { PlanPanel } from './PlanPanel'

vi.mock('@web-agent/core/runtime/commands', () => ({ approvePlan: vi.fn(), acceptPlanResult: vi.fn() }))

describe('PlanPanel', () => {
  it('展示全部阶段状态，并通过宿主命令批准', () => {
    const store = createStore()
    store.setter(planAtom, {
      id: 'p1', title: '发布功能', objective: '可靠交付', status: 'awaiting_approval', revision: 1,
      requiresApproval: true, createdAt: 1, updatedAt: 1,
      stages: [
        { id: 'a', title: '实现', objective: '写代码', deliverables: [], acceptanceCriteria: ['测试通过'], dependencies: [], status: 'pending', evidence: [] },
        { id: 'b', title: '验证', objective: '做回归', deliverables: [], acceptanceCriteria: ['构建通过'], dependencies: ['a'], status: 'pending', evidence: [] },
      ],
    })
    store.setter(runAtom, { runId: 'r1', status: 'waiting_plan_approval', pendingPlanApproval: { callId: 'c1', planId: 'p1', revision: 1 } })
    renderWithStore(<PlanPanel />, { store })
    expect(screen.getByText('实现')).toBeInTheDocument()
    expect(screen.getByText('验证')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '批准并继续' }))
    expect(approvePlan).toHaveBeenCalledWith(true)
  })

  it('逐条展示 evaluator 结论，并由宿主验收最终结果', () => {
    const store = createStore()
    store.setter(planAtom, {
      schemaVersion: 2,
      id: 'p2', title: '发布功能', objective: '可靠交付', status: 'awaiting_user_acceptance', revision: 8,
      requiresApproval: false, createdAt: 1, updatedAt: 2,
      stages: [{
        id: 'a', title: '实现', objective: '写代码', deliverables: [], acceptanceCriteria: ['测试通过'], dependencies: [], status: 'completed', evidence: ['3 tests passed'],
        evaluations: [{ attempt: 1, status: 'passed', summary: '实现完成', submittedEvidence: ['3 tests passed'], submittedAt: 2, evaluatedAt: 3, criteria: [{ criterion: '测试通过', status: 'passed', evidence: ['3 tests passed'], reason: '' }] }],
      }],
      evaluation: { status: 'passed', evidence: ['full regression passed'], reason: '', evaluatedAt: 4, requiresUserAcceptance: true },
    })
    renderWithStore(<PlanPanel />, { store })
    expect(screen.getByText('通过')).toBeInTheDocument()
    expect(screen.getAllByText('证据：3 tests passed')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: '接受结果' }))
    expect(acceptPlanResult).toHaveBeenCalledWith('p2', 8, true)
  })
})
