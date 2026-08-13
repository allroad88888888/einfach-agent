import { createStore } from '@einfach/core'
import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithStore } from '../../test/renderWithStore'
import {
  itemsAtom,
  planAtom,
  runAtom,
  approvePlan,
  continuePlan,
  rollbackPlanStage,
} from '@web-agent/core'
import { PlanPanel } from './PlanPanel'
import {
  MESSAGE_WINDOW_SIZE,
  MESSAGE_WINDOW_STEP,
  planTraceWindowsAtom,
} from './messageWindowModel'

vi.mock('@web-agent/core/runtime/commands', () => ({
  approvePlan: vi.fn(),
  continuePlan: vi.fn(),
  rollbackPlanStage: vi.fn(),
  answerQuestion: vi.fn(),
  resumeWithAnswers: vi.fn(),
}))

describe('PlanPanel', () => {
  it('制定计划时的用户决策显示在 Plan 容器内，并可在尚无 plan 快照时中断', () => {
    const store = createStore()
    const payload = {
      title: '确定交付范围',
      questions: [{ id: 'scope', text: '包含迁移脚本吗？', type: 'confirm' }],
    }
    store.setter(runAtom, {
      runId: 'r-draft',
      status: 'waiting_user',
      pendingQuestion: payload,
      pendingUserDecision: {
        callId: 'ask-draft',
        payload,
        origin: { surface: 'plan', phase: 'drafting' },
      },
    })

    const { container } = renderWithStore(<PlanPanel />, { store })

    const plan = container.querySelector('.agentnew-plan.is-drafting')
    const ask = plan?.querySelector('.agentnew-ask.is-plan-embedded')
    expect(plan).not.toBeNull()
    expect(ask).not.toBeNull()
    expect(plan).toHaveTextContent('等待决策')
    expect(plan).toHaveTextContent('包含迁移脚本吗？')
  })

  it('执行阶段的决策嵌入对应 stage，并强制展开等待中的 stage', () => {
    const store = createStore()
    store.setter(planAtom, {
      id: 'p-decision', title: '交付功能', objective: '完成实现', status: 'active', revision: 2,
      requiresApproval: false, createdAt: 1, updatedAt: 2,
      stages: [{
        id: 'implement', title: '实现', objective: '写代码', deliverables: [],
        dependencies: [], status: 'in_progress', evidence: [],
      }],
    })
    const payload = {
      title: '选择兼容策略',
      questions: [{ id: 'compat', text: '保留旧接口吗？', type: 'confirm' }],
    }
    store.setter(runAtom, {
      runId: 'r-stage',
      status: 'waiting_user',
      pendingQuestion: payload,
      pendingUserDecision: {
        callId: 'ask-stage',
        payload,
        origin: {
          surface: 'plan', phase: 'executing', planId: 'p-decision', planRevision: 2, stageId: 'implement',
        },
      },
    })

    const { container } = renderWithStore(<PlanPanel />, { store })

    const details = screen.getByText('实现', { selector: 'summary strong' }).closest('details')
    expect(details).toHaveAttribute('open')
    expect(details).toHaveTextContent('等待决策')
    expect(details?.querySelector('.agentnew-ask.is-plan-embedded')).not.toBeNull()
    expect(container.querySelectorAll('.agentnew-ask')).toHaveLength(1)
  })

  it('展示全部阶段状态，并通过宿主命令批准', () => {
    const store = createStore()
    store.setter(planAtom, {
      id: 'p1', title: '发布功能', objective: '可靠交付', status: 'awaiting_approval', revision: 1,
      requiresApproval: true, createdAt: 1, updatedAt: 1,
      stages: [
        { id: 'a', title: '实现', objective: '写代码', deliverables: [], dependencies: [], status: 'pending', evidence: [] },
        { id: 'b', title: '验证', objective: '做回归', deliverables: [], dependencies: ['a'], status: 'pending', evidence: [] },
      ],
    })
    store.setter(runAtom, { runId: 'r1', status: 'waiting_plan_approval', pendingPlanApproval: { callId: 'c1', planId: 'p1', revision: 1 } })
    renderWithStore(<PlanPanel />, { store })
    expect(screen.getByText('实现', { selector: 'summary strong' })).toBeInTheDocument()
    expect(screen.getByText('验证', { selector: 'summary strong' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '批准并继续' }))
    expect(approvePlan).toHaveBeenCalledWith(true)
  })

  it('展开已完成阶段时展示提交的产出摘要与证据', () => {
    const store = createStore()
    store.setter(planAtom, {
      schemaVersion: 4,
      id: 'p2', title: '发布功能', objective: '可靠交付', status: 'completed', revision: 8,
      requiresApproval: false, createdAt: 1, updatedAt: 2,
      stages: [{
        id: 'a', title: '实现', objective: '写代码', deliverables: [], dependencies: [], status: 'completed', evidence: ['3 tests passed'],
        result: { summary: '实现完成', evidence: ['3 tests passed'], submittedAt: 2 },
      }],
    })
    renderWithStore(<PlanPanel />, { store })
    expect(screen.queryByText('实现完成')).toBeNull()
    fireEvent.click(screen.getByText('实现', { selector: 'summary strong' }).closest('summary')!)
    expect(screen.getByText('实现完成')).toBeInTheDocument()
    expect(screen.getByText('证据：3 tests passed')).toBeInTheDocument()
  })

  it('阻塞阶段展示阻塞原因', () => {
    const store = createStore()
    store.setter(planAtom, {
      schemaVersion: 4,
      id: 'p3', title: '发布功能', objective: '可靠交付', status: 'active', revision: 4,
      requiresApproval: false, createdAt: 1, updatedAt: 2,
      stages: [{
        id: 'a', title: '实现', objective: '写代码', deliverables: [], dependencies: [], status: 'blocked', evidence: [],
        blockReason: '上游接口尚未提供',
      }],
    })
    renderWithStore(<PlanPanel />, { store })
    fireEvent.click(screen.getByText('实现', { selector: 'summary strong' }).closest('summary')!)
    expect(screen.getByText('已阻塞')).toBeInTheDocument()
    expect(screen.getByText('阻塞：上游接口尚未提供')).toBeInTheDocument()
  })

  it('每个步骤可独立展开详情，执行中的步骤默认展开并展示交付物与依赖', () => {
    const store = createStore()
    store.setter(planAtom, {
      id: 'p3', title: '多步骤任务', objective: '完成实现与验证', status: 'active', revision: 3,
      requiresApproval: false, createdAt: 1, updatedAt: 2,
      stages: [
        {
          id: 'design', title: '设计', objective: '确定方案', deliverables: ['设计说明'],
          dependencies: [], status: 'completed', evidence: [],
        },
        {
          id: 'implement', title: '实现', objective: '完成代码', deliverables: ['功能代码', '单元测试'],
          dependencies: ['design'], status: 'in_progress', evidence: [],
        },
      ],
    })

    renderWithStore(<PlanPanel />, { store })

    const designTitle = screen.getByText('设计', { selector: 'summary strong' })
    const designDetails = designTitle.closest('details')
    const implementDetails = screen.getByText('实现', { selector: 'summary strong' }).closest('details')
    expect(designDetails).not.toHaveAttribute('open')
    expect(screen.queryByText('设计说明')).toBeNull()
    expect(implementDetails).toHaveAttribute('open')
    expect(implementDetails).toHaveTextContent('功能代码')
    expect(implementDetails).toHaveTextContent('单元测试')
    expect(implementDetails).toHaveTextContent('依赖设计')

    fireEvent.click(designTitle.closest('summary')!)
    expect(designDetails).toHaveAttribute('open')
    expect(designDetails).toHaveTextContent('设计说明')
  })

  it('每个阶段均提供回滚入口，已开始的阶段可回滚到该阶段', () => {
    const store = createStore()
    store.setter(planAtom, {
      id: 'p-rollback', title: '多步骤任务', objective: '完成实现与验证', status: 'active', revision: 3,
      requiresApproval: false, createdAt: 1, updatedAt: 2,
      stages: [
        { id: 'design', title: '设计', objective: '确定方案', deliverables: [], dependencies: [], status: 'completed', evidence: [] },
        { id: 'implement', title: '实现', objective: '完成代码', deliverables: [], dependencies: ['design'], status: 'in_progress', evidence: [] },
        { id: 'verify', title: '验证', objective: '执行回归', deliverables: [], dependencies: ['implement'], status: 'pending', evidence: [] },
      ],
    })

    renderWithStore(<PlanPanel />, { store })

    const designSummary = screen.getByText('设计', { selector: 'summary strong' }).closest('summary')!
    expect(designSummary).toHaveTextContent('回滚已完成')
    fireEvent.click(designSummary)
    const rollbackButtons = screen.getAllByRole('button', { name: '回滚' })
    expect(rollbackButtons).toHaveLength(3)
    expect(rollbackButtons[2]).toBeDisabled()
    fireEvent.click(rollbackButtons[0])
    expect(rollbackPlanStage).toHaveBeenCalledWith('p-rollback', 3, 'design')
  })

  it('可收缩整个计划，仅保留概要并可展开恢复', () => {
    const store = createStore()
    store.setter(planAtom, {
      id: 'p-collapse', title: '多步骤任务', objective: '完成实现与验证', status: 'active', revision: 1,
      requiresApproval: false, createdAt: 1, updatedAt: 2,
      stages: [{
        id: 'implement', title: '实现', objective: '完成代码', deliverables: [],
        dependencies: [], status: 'in_progress', evidence: [],
      }],
    })

    renderWithStore(<PlanPanel />, { store })

    expect(screen.getByText('实现', { selector: 'summary strong' })).toBeInTheDocument()
    const toggle = screen.getByRole('button', { name: '收起计划详情' })
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('实现', { selector: 'summary strong' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '展开计划详情' }))
    expect(screen.getByText('实现', { selector: 'summary strong' })).toBeInTheDocument()
  })

  it('持久化恢复的执行中计划显示为待继续，并提供继续入口', () => {
    const store = createStore()
    store.setter(planAtom, {
      id: 'p-resume', title: '恢复任务', objective: '继续未完成工作', status: 'active', revision: 4,
      requiresApproval: false, createdAt: 1, updatedAt: 2,
      stages: [{
        id: 'implement', title: '实现', objective: '完成代码', deliverables: [],
        dependencies: [], status: 'in_progress', evidence: [],
      }],
    })

    renderWithStore(<PlanPanel />, { store })

    expect(screen.getAllByText('待继续')).toHaveLength(2)
    expect(screen.getByText('当前没有 Agent 在运行。', { exact: false })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '继续执行' }))
    expect(continuePlan).toHaveBeenCalledOnce()
  })

  it('当前 run 真正在执行时仍显示进行中，不展示继续按钮', () => {
    const store = createStore()
    store.setter(planAtom, {
      id: 'p-running', title: '运行任务', objective: '执行工作', status: 'active', revision: 1,
      requiresApproval: false, createdAt: 1, updatedAt: 2,
      stages: [{
        id: 'implement', title: '实现', objective: '完成代码', deliverables: [],
        dependencies: [], status: 'in_progress', evidence: [],
      }],
    })
    store.setter(runAtom, { runId: 'r-running', status: 'running' })

    renderWithStore(<PlanPanel />, { store })

    expect(screen.getByText('执行中')).toBeInTheDocument()
    expect(screen.getByText('进行中')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '继续执行' })).not.toBeInTheDocument()
  })

  it('中断遗留的 awaiting_tool 显示继续入口', () => {
    vi.mocked(continuePlan).mockClear()
    const store = createStore()
    store.setter(planAtom, {
      id: 'p-orphaned-run', title: '恢复执行', objective: '继续未完成工作', status: 'active', revision: 4,
      requiresApproval: false, createdAt: 1, updatedAt: 2,
      stages: [{
        id: 'implement', title: '实现', objective: '完成代码', deliverables: [],
        dependencies: [], status: 'in_progress', evidence: [],
      }],
    })
    store.setter(runAtom, { runId: 'orphaned-run', status: 'awaiting_tool' })

    renderWithStore(<PlanPanel />, { store })

    expect(screen.getAllByText('待继续')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: '继续执行' }))
    expect(continuePlan).toHaveBeenCalledOnce()
  })

  it('在对应步骤详情中展示该步骤的模型思考、工具调用与结果', () => {
    const store = createStore()
    store.setter(planAtom, {
      id: 'p4', title: '执行任务', objective: '完成检索', status: 'active', revision: 1,
      requiresApproval: false, createdAt: 1, updatedAt: 2,
      stages: [{
        id: 'search', title: '检索代码', objective: '找到实现位置', deliverables: [],
        dependencies: [], status: 'in_progress', evidence: [],
      }],
    })
    store.setter(itemsAtom, [
      {
        id: 'assistant-trace',
        createdAt: 3,
        planStageId: 'search',
        item: {
          role: 'assistant',
          content: '先搜索相关组件。',
          reasoning_content: '需要找到计划面板的实现。',
          tool_calls: [{
            id: 'call-search',
            type: 'function',
            function: { name: 'rg_search', arguments: '{"query":"PlanPanel"}' },
          }],
        },
      },
      {
        id: 'tool-trace',
        createdAt: 4,
        planStageId: 'search',
        item: {
          role: 'tool',
          tool_call_id: 'call-search',
          content: '{"matches":["PlanPanel.tsx"]}',
        },
      },
      {
        id: 'assistant-stage-summary',
        createdAt: 5,
        planStageId: 'search',
        item: {
          role: 'assistant',
          content: '阶段检索完成，但整个计划尚未完成。',
        },
      },
    ])

    renderWithStore(<PlanPanel />, { store })

    const details = screen.getByText('检索代码', { selector: 'summary strong' }).closest('details')
    expect(details).toHaveTextContent('执行记录')
    expect(details).toHaveTextContent('模型思考')
    expect(details).toHaveTextContent('需要找到计划面板的实现。')
    expect(details).toHaveTextContent('工具 rg_search')
    expect(details).toHaveTextContent('调用：query=PlanPanel')
    expect(details).toHaveTextContent('结果：')
    expect(details).toHaveTextContent('阶段检索完成，但整个计划尚未完成。')
    expect(screen.queryByText('阶段检索完成，但整个计划尚未完成。')?.closest('.agentnew-msg')).toBeNull()
  })

  it('长阶段执行记录复用滑动窗口，向上换窗时维持固定挂载数量', () => {
    const store = createStore()
    store.setter(planAtom, {
      id: 'p-window', title: '长任务', objective: '持续执行', status: 'active', revision: 1,
      requiresApproval: false, createdAt: 1, updatedAt: 2,
      stages: [{
        id: 'execute', title: '执行', objective: '处理大量步骤', deliverables: [],
        dependencies: [], status: 'in_progress', evidence: [],
      }],
    })
    store.setter(itemsAtom, Array.from({ length: 500 }, (_, index) => ({
      id: `trace-${index}`,
      createdAt: index + 10,
      planStageId: 'execute',
      item: {
        role: 'assistant' as const,
        content: `第 ${index + 1} 条执行记录`,
      },
    })))

    const { container } = renderWithStore(<PlanPanel />, { store })
    const traceWindow = container.querySelector<HTMLElement>(
      '.agentnew-plan-stage-trace-window',
    )
    expect(traceWindow).not.toBeNull()
    expect(container.querySelectorAll('.agentnew-plan-trace-row')).toHaveLength(
      MESSAGE_WINDOW_SIZE,
    )
    expect(screen.getByText('第 500 条执行记录')).toBeInTheDocument()
    expect(screen.queryByText('第 1 条执行记录')).toBeNull()

    Object.defineProperties(traceWindow!, {
      clientHeight: { configurable: true, value: 420 },
      scrollHeight: { configurable: true, value: 4_000 },
    })
    traceWindow!.scrollTop = 0
    fireEvent.scroll(traceWindow!)

    expect(store.getter(planTraceWindowsAtom)['p-window:execute']).toMatchObject({
      start: 500 - MESSAGE_WINDOW_SIZE - MESSAGE_WINDOW_STEP,
      end: 500 - MESSAGE_WINDOW_STEP,
      direction: 'backward',
    })
    expect(container.querySelectorAll('.agentnew-plan-trace-row')).toHaveLength(
      MESSAGE_WINDOW_SIZE,
    )
    expect(screen.getByText('第 397 条执行记录')).toBeInTheDocument()
    expect(screen.queryByText('第 500 条执行记录')).toBeNull()
  })

  it('blocked 阶段展开后展示阻塞原因', () => {
    const store = createStore()
    store.setter(planAtom, {
      id: 'p-blocked', title: '发布功能', objective: '可靠交付', status: 'active', revision: 1,
      requiresApproval: false, createdAt: 1, updatedAt: 2,
      stages: [{
        id: 'verify', title: '验证', objective: '执行回归', deliverables: [],
        dependencies: [], status: 'blocked', evidence: [],
        blockReason: '需要实跑集成测试才能核验，评估器只有只读权限',
      }],
    })

    renderWithStore(<PlanPanel />, { store })

    const summary = screen.getByText('验证', { selector: 'summary strong' }).closest('summary')!
    expect(summary).toHaveTextContent('已阻塞')
    fireEvent.click(summary)
    expect(summary.closest('details')).toHaveTextContent('阻塞：需要实跑集成测试才能核验，评估器只有只读权限')
  })

})
