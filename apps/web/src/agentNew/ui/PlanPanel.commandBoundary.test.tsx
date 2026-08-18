import { createStore } from '@einfach/core'
import { fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  approvePlan,
  planAtom,
  rollbackPlanStage,
  runAtom,
} from '@web-agent/core'
import { renderWithStore } from '../../test/renderWithStore'
import { PlanPanel } from './PlanPanel'

vi.mock('@web-agent/core/runtime/commands', () => ({
  approvePlan: vi.fn(),
  continuePlan: vi.fn(),
  rollbackPlanStage: vi.fn(),
  answerQuestion: vi.fn(),
  resumeWithAnswers: vi.fn(),
}))

let unhandled: unknown[] = []
const onUnhandled = (event: PromiseRejectionEvent) => {
  unhandled.push(event.reason)
}

afterEach(() => {
  window.removeEventListener('unhandledrejection', onUnhandled)
  vi.clearAllMocks()
})

async function settleCommandRejections(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('PlanPanel 命令 Promise 边界', () => {
  it('审批命令拒绝时不产生未处理 Promise rejection', async () => {
    const store = createStore()
    store.setter(planAtom, {
      id: 'p-approval', title: '待审批', objective: '验证异步边界', status: 'awaiting_approval', revision: 1,
      requiresApproval: true, createdAt: 1, updatedAt: 1,
      stages: [{
        id: 'stage-1', title: '审批阶段', objective: '等待审批', deliverables: [],
        dependencies: [], status: 'pending', evidence: [],
      }],
    })
    store.setter(runAtom, {
      runId: 'run-approval',
      status: 'waiting_plan_approval',
      pendingPlanApproval: { callId: 'call-approval', planId: 'p-approval', revision: 1 },
    })
    unhandled = []
    window.addEventListener('unhandledrejection', onUnhandled)
    vi.mocked(approvePlan)
      .mockRejectedValueOnce(new Error('reject approval'))
      .mockRejectedValueOnce(new Error('approve rejection'))

    renderWithStore(<PlanPanel />, { agentStore: store })
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }))
    fireEvent.click(screen.getByRole('button', { name: '批准并继续' }))
    await settleCommandRejections()

    expect(approvePlan).toHaveBeenNthCalledWith(1, false)
    expect(approvePlan).toHaveBeenNthCalledWith(2, true)
    expect(unhandled).toHaveLength(0)
  })

  it('回退命令拒绝时不产生未处理 Promise rejection', async () => {
    const store = createStore()
    store.setter(planAtom, {
      id: 'p-rollback', title: '可回退', objective: '验证异步边界', status: 'active', revision: 3,
      requiresApproval: false, createdAt: 1, updatedAt: 1,
      stages: [{
        id: 'stage-1', title: '已完成阶段', objective: '允许回退', deliverables: [],
        dependencies: [], status: 'completed', evidence: [],
      }],
    })
    unhandled = []
    window.addEventListener('unhandledrejection', onUnhandled)
    vi.mocked(rollbackPlanStage).mockRejectedValueOnce(new Error('rollback rejection'))

    renderWithStore(<PlanPanel />, { agentStore: store })
    fireEvent.click(screen.getByRole('button', { name: '回滚' }))
    await settleCommandRejections()

    expect(rollbackPlanStage).toHaveBeenCalledWith('p-rollback', 3, 'stage-1')
    expect(unhandled).toHaveLength(0)
  })
})
