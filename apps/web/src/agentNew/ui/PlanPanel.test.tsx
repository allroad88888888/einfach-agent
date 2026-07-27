import { createStore } from '@einfach/core'
import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithStore } from '../../test/renderWithStore'
import { itemsAtom, planAtom, runAtom } from '@web-agent/core/state/sessionAtoms'
import { acceptPlanResult, approvePlan, continuePlan } from '@web-agent/core/runtime/commands'
import { PlanPanel } from './PlanPanel'
import {
  MESSAGE_WINDOW_SIZE,
  MESSAGE_WINDOW_STEP,
  planTraceWindowsAtom,
} from './messageWindowModel'

vi.mock('@web-agent/core/runtime/commands', () => ({
  approvePlan: vi.fn(),
  acceptPlanResult: vi.fn(),
  continuePlan: vi.fn(),
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
        acceptanceCriteria: ['测试通过'], dependencies: [], status: 'in_progress', evidence: [],
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
        { id: 'a', title: '实现', objective: '写代码', deliverables: [], acceptanceCriteria: ['测试通过'], dependencies: [], status: 'pending', evidence: [] },
        { id: 'b', title: '验证', objective: '做回归', deliverables: [], acceptanceCriteria: ['构建通过'], dependencies: ['a'], status: 'pending', evidence: [] },
      ],
    })
    store.setter(runAtom, { runId: 'r1', status: 'waiting_plan_approval', pendingPlanApproval: { callId: 'c1', planId: 'p1', revision: 1 } })
    renderWithStore(<PlanPanel />, { store })
    expect(screen.getByText('实现', { selector: 'summary strong' })).toBeInTheDocument()
    expect(screen.getByText('验证', { selector: 'summary strong' })).toBeInTheDocument()
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
    expect(screen.queryByText('证据：3 tests passed')).toBeNull()
    fireEvent.click(screen.getByText('实现', { selector: 'summary strong' }).closest('summary')!)
    expect(screen.getByText('通过')).toBeInTheDocument()
    expect(screen.getAllByText('证据：3 tests passed')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: '接受结果' }))
    expect(acceptPlanResult).toHaveBeenCalledWith('p2', 8, true)
  })

  it('每个步骤可独立展开详情，执行中的步骤默认展开并展示交付物与依赖', () => {
    const store = createStore()
    store.setter(planAtom, {
      id: 'p3', title: '多步骤任务', objective: '完成实现与验证', status: 'active', revision: 3,
      requiresApproval: false, createdAt: 1, updatedAt: 2,
      stages: [
        {
          id: 'design', title: '设计', objective: '确定方案', deliverables: ['设计说明'],
          acceptanceCriteria: ['方案可执行'], dependencies: [], status: 'completed', evidence: [],
        },
        {
          id: 'implement', title: '实现', objective: '完成代码', deliverables: ['功能代码', '单元测试'],
          acceptanceCriteria: ['测试通过'], dependencies: ['design'], status: 'in_progress', evidence: [],
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

  it('持久化恢复的执行中计划显示为待继续，并提供继续入口', () => {
    const store = createStore()
    store.setter(planAtom, {
      id: 'p-resume', title: '恢复任务', objective: '继续未完成工作', status: 'active', revision: 4,
      requiresApproval: false, createdAt: 1, updatedAt: 2,
      stages: [{
        id: 'implement', title: '实现', objective: '完成代码', deliverables: [],
        acceptanceCriteria: ['测试通过'], dependencies: [], status: 'in_progress', evidence: [],
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
        acceptanceCriteria: ['测试通过'], dependencies: [], status: 'in_progress', evidence: [],
      }],
    })
    store.setter(runAtom, { runId: 'r-running', status: 'running' })

    renderWithStore(<PlanPanel />, { store })

    expect(screen.getByText('执行中')).toBeInTheDocument()
    expect(screen.getByText('进行中')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '继续执行' })).not.toBeInTheDocument()
  })

  it('已取消评审遗留的 awaiting_tool 显示继续入口', () => {
    vi.mocked(continuePlan).mockClear()
    const store = createStore()
    store.setter(planAtom, {
      id: 'p-orphaned-evaluation', title: '恢复评审', objective: '继续未完成工作', status: 'active', revision: 4,
      requiresApproval: false, createdAt: 1, updatedAt: 2,
      stages: [{
        id: 'implement', title: '实现', objective: '完成代码', deliverables: [],
        acceptanceCriteria: ['测试通过'], dependencies: [], status: 'evaluating', evidence: [],
      }],
    })
    store.setter(runAtom, { runId: 'orphaned-evaluation', status: 'awaiting_tool' })

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
        acceptanceCriteria: ['定位文件'], dependencies: [], status: 'in_progress', evidence: [],
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
        acceptanceCriteria: ['完成'], dependencies: [], status: 'in_progress', evidence: [],
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
})
