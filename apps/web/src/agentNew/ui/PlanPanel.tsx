import { useAtom, useAtomValue } from '@einfach/react'
import { useMemo } from 'react'
import { itemsAtom, planAtom, runAtom } from '@web-agent/core/state/sessionAtoms'
import { activeExecutionNodeIdsAtom, executionGraphAtom } from '@web-agent/core/execution/graph'
import {
  assistantStreamAtom,
  expandedPlanStagesAtom,
} from '@web-agent/core/state/transientAtoms'
import { acceptPlanResult, approvePlan, continuePlan } from '@web-agent/core/runtime/commands'
import type { PlanStageStatus } from '@web-agent/core/planning/types'
import {
  performanceNow,
  recordPerformanceDiagnostic,
} from '@web-agent/core/observability/performanceDiagnostics'
import { buildPlanStageExecutionEntries, PlanStageExecutionTrace } from './MessageList'
import { AskUserQuestionCard } from './AskUserQuestionCard'

const statusText: Record<PlanStageStatus, string> = {
  pending: '待开始',
  in_progress: '进行中',
  evaluating: '评估中',
  completed: '已完成',
  failed: '未通过',
  blocked: '已阻塞',
  skipped: '已跳过',
}

const planStatusText = {
  draft: '草稿', awaiting_approval: '待批准', approved: '已批准', active: '执行中', evaluating: '最终评估中',
  awaiting_user_acceptance: '待用户验收', completed: '已完成', failed: '未通过', rejected: '用户未接受', cancelled: '已取消',
} as const

export function PlanPanel() {
  const plan = useAtomValue(planAtom)
  const run = useAtomValue(runAtom)
  const executionGraph = useAtomValue(executionGraphAtom)
  const activeExecutionNodeIds = useAtomValue(activeExecutionNodeIdsAtom)
  const items = useAtomValue(itemsAtom)
  const assistantStream = useAtomValue(assistantStreamAtom)
  const [expandedStages, setExpandedStages] = useAtom(expandedPlanStagesAtom)
  const streamedItemId = assistantStream?.item.id
  const historicalItems = useMemo(
    () => streamedItemId ? items.filter((item) => item.id !== streamedItemId) : items,
    [items, streamedItemId],
  )
  const executionEntriesByStage = useMemo(() => {
    const startedAt = performanceNow()
    const entries = buildPlanStageExecutionEntries(historicalItems)
    const durationMs = performanceNow() - startedAt
    if (durationMs >= 16) {
      recordPerformanceDiagnostic(
        'ui.plan_execution_index',
        durationMs,
        {
          sessionItemCount: historicalItems.length,
          stageBucketCount: entries.size,
          thresholdMs: 16,
        },
        { slowMs: 16 },
      )
    }
    return entries
  }, [historicalItems])
  const streamingEntriesByStage = useMemo(
    () => assistantStream
      ? buildPlanStageExecutionEntries([assistantStream.item])
      : buildPlanStageExecutionEntries([]),
    [assistantStream],
  )
  const planDecision = run?.status === 'waiting_user'
    && run.pendingUserDecision?.origin.surface === 'plan'
    ? run.pendingUserDecision
    : undefined
  if (!plan) {
    if (!planDecision) return null
    return (
      <section className="agentnew-plan is-drafting" aria-labelledby="agentnew-plan-title">
        <header className="agentnew-plan-header">
          <div>
            <span className="agentnew-plan-eyebrow">正在制定计划</span>
            <h2 id="agentnew-plan-title" className="agentnew-plan-title">需要你的决策</h2>
            <p className="agentnew-plan-objective">回答后会从当前位置继续生成同一份计划。</p>
          </div>
          <span className="agentnew-plan-status is-awaiting-decision">等待决策</span>
        </header>
        <AskUserQuestionCard surface="plan" />
      </section>
    )
  }
  const hasActiveExecution = run != null && activeExecutionNodeIds
    .some((executionId) => executionGraph.nodes[executionId]?.runId === run.runId)
  const runIsAttached = run != null && (
    ['running', 'waiting_user', 'waiting_confirmation', 'waiting_plan_approval'].includes(run.status)
    || (run.status === 'awaiting_tool' && (run.pendingExecutionId != null || hasActiveExecution))
  )
  const planIsUnfinished = ['approved', 'active', 'evaluating'].includes(plan.status)
    && plan.stages.some((stage) => ['pending', 'in_progress', 'evaluating'].includes(stage.status))
  const canContinue = planIsUnfinished && !runIsAttached
  const awaitingApproval = plan.status === 'awaiting_approval'
    && run?.status === 'waiting_plan_approval'
    && run.pendingPlanApproval?.planId === plan.id
  const stageTitleById = new Map(plan.stages.map((stage) => [stage.id, stage.title]))
  const decisionStageId = planDecision?.origin.stageId
  const decisionBelongsToStage = decisionStageId != null
    && plan.stages.some((stage) => stage.id === decisionStageId)

  return (
    <section className="agentnew-plan" aria-labelledby="agentnew-plan-title">
      <header className="agentnew-plan-header">
        <div>
          <span className="agentnew-plan-eyebrow">执行计划 · r{plan.revision}</span>
          <h2 id="agentnew-plan-title" className="agentnew-plan-title">{plan.title}</h2>
          <p className="agentnew-plan-objective">{plan.objective}</p>
        </div>
        <span className={`agentnew-plan-status ${planDecision ? 'is-awaiting-decision' : canContinue ? 'is-paused' : `is-${plan.status}`}`}>
          {planDecision ? '等待决策' : canContinue ? '待继续' : planStatusText[plan.status]}
        </span>
      </header>

      {planDecision && !decisionBelongsToStage ? <AskUserQuestionCard surface="plan" /> : null}

      <ol className="agentnew-plan-stages">
        {plan.stages.map((stage) => {
          const latestEvaluation = stage.evaluations?.at(-1)
          const evaluationByCriterion = new Map(latestEvaluation?.criteria.map((item) => [item.criterion, item]))
          const pausedStage = canContinue && (stage.status === 'in_progress' || stage.status === 'evaluating')
          const awaitingDecision = decisionStageId === stage.id
          const defaultExpanded = stage.status === 'in_progress' || stage.status === 'evaluating'
          const expanded = awaitingDecision || (expandedStages[stage.id] ?? defaultExpanded)
          return (
          <li key={stage.id} className={`agentnew-plan-stage ${awaitingDecision ? 'is-awaiting-decision' : pausedStage ? 'is-paused' : `is-${stage.status}`}`}>
            <span className="agentnew-plan-stage-marker" aria-hidden="true" />
            <details className="agentnew-plan-stage-details" open={expanded}>
              <summary
                className="agentnew-plan-stage-heading"
                onClick={(event) => {
                  event.preventDefault()
                  setExpandedStages((current) => ({
                    ...current,
                    [stage.id]: !expanded,
                  }))
                }}
              >
                <strong>{stage.title}</strong>
                <span>{awaitingDecision ? '等待决策' : pausedStage ? '待继续' : statusText[stage.status]}</span>
                <i aria-hidden="true">⌄</i>
              </summary>
              {expanded ? <div className="agentnew-plan-stage-body">
                <p>{stage.objective}</p>
                <div className="agentnew-plan-stage-meta">
                  <div>
                    <strong>交付物</strong>
                    {stage.deliverables.length > 0
                      ? <ul>{stage.deliverables.map((item) => <li key={item}>{item}</li>)}</ul>
                      : <span>未单独指定</span>}
                  </div>
                  <div>
                    <strong>依赖</strong>
                    <span>
                      {stage.dependencies.length > 0
                        ? stage.dependencies.map((id) => stageTitleById.get(id) ?? id).join('、')
                        : '无'}
                    </span>
                  </div>
                </div>
                <strong className="agentnew-plan-section-title">验收标准</strong>
                <ul className="agentnew-plan-criteria" aria-label={`${stage.title}验收标准`}>
                  {stage.acceptanceCriteria.map((criterion) => {
                    const evaluation = evaluationByCriterion.get(criterion)
                    return (
                      <li key={criterion} className={`is-${evaluation?.status ?? 'pending'}`}>
                        <span>{evaluation?.status === 'passed' ? '通过' : evaluation?.status === 'failed' ? '失败' : evaluation?.status === 'unknown' ? '未知' : '待评估'}</span>
                        <span>{criterion}</span>
                        {evaluation?.evidence.length ? <small>证据：{evaluation.evidence.join('；')}</small> : null}
                        {evaluation?.reason ? <small>原因：{evaluation.reason}</small> : null}
                      </li>
                    )
                  })}
                </ul>
                {latestEvaluation && <div className="agentnew-plan-evaluation-summary">第 {latestEvaluation.attempt} 次提交：{latestEvaluation.summary}</div>}
                {stage.evidence.length > 0 && (
                  <div className="agentnew-plan-evidence">证据：{stage.evidence.join('；')}</div>
                )}
                {stage.blockReason && <div className="agentnew-plan-block">阻塞：{stage.blockReason}</div>}
                <PlanStageExecutionTrace
                  windowId={`${plan.id}:${stage.id}`}
                  stageId={stage.id}
                  entries={[
                    ...(executionEntriesByStage.get(stage.id) ?? []),
                    ...(streamingEntriesByStage.get(stage.id) ?? []),
                  ]}
                />
                {awaitingDecision ? <AskUserQuestionCard surface="plan" /> : null}
              </div> : null}
            </details>
          </li>
          )
        })}
      </ol>

      {plan.evaluation && (
        <div className={`agentnew-plan-final-evaluation is-${plan.evaluation.status}`}>
          <strong>整体验收：{plan.evaluation.status === 'passed' ? '通过' : plan.evaluation.status === 'failed' ? '失败' : '未知'}</strong>
          {plan.evaluation.evidence.length > 0 && <span>证据：{plan.evaluation.evidence.join('；')}</span>}
          {plan.evaluation.reason && <span>说明：{plan.evaluation.reason}</span>}
        </div>
      )}

      {awaitingApproval && (
        <footer className="agentnew-plan-approval">
          <span>请确认这份计划后再开始执行。</span>
          <div>
            <button type="button" className="agentnew-confirm-reject" onClick={() => approvePlan(false)}>拒绝</button>
            <button type="button" className="agentnew-confirm-approve" onClick={() => approvePlan(true)}>批准并继续</button>
          </div>
        </footer>
      )}
      {plan.status === 'awaiting_user_acceptance' && (
        <footer className="agentnew-plan-approval">
          <span>自动评估已通过，请验收最终结果。</span>
          <div>
            <button type="button" className="agentnew-confirm-reject" onClick={() => acceptPlanResult(plan.id, plan.revision, false)}>拒绝结果</button>
            <button type="button" className="agentnew-confirm-approve" onClick={() => acceptPlanResult(plan.id, plan.revision, true)}>接受结果</button>
          </div>
        </footer>
      )}
      {canContinue && (
        <footer className="agentnew-plan-approval agentnew-plan-resume">
          <span>这是上次保存的计划进度，当前没有 Agent 在运行。</span>
          <button type="button" className="agentnew-confirm-approve" onClick={continuePlan}>继续执行</button>
        </footer>
      )}
    </section>
  )
}
