import { useAtomValue } from '@einfach/react'
import { planAtom, runAtom } from '@web-agent/core/state/sessionAtoms'
import { acceptPlanResult, approvePlan } from '@web-agent/core/runtime/commands'
import type { PlanStageStatus } from '@web-agent/core/planning/types'

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
  if (!plan) return null
  const awaitingApproval = plan.status === 'awaiting_approval'
    && run?.status === 'waiting_plan_approval'
    && run.pendingPlanApproval?.planId === plan.id

  return (
    <section className="agentnew-plan" aria-labelledby="agentnew-plan-title">
      <header className="agentnew-plan-header">
        <div>
          <span className="agentnew-plan-eyebrow">执行计划 · r{plan.revision}</span>
          <h2 id="agentnew-plan-title" className="agentnew-plan-title">{plan.title}</h2>
          <p className="agentnew-plan-objective">{plan.objective}</p>
        </div>
        <span className={`agentnew-plan-status is-${plan.status}`}>{planStatusText[plan.status]}</span>
      </header>

      <ol className="agentnew-plan-stages">
        {plan.stages.map((stage) => {
          const latestEvaluation = stage.evaluations?.at(-1)
          const evaluationByCriterion = new Map(latestEvaluation?.criteria.map((item) => [item.criterion, item]))
          return (
          <li key={stage.id} className={`agentnew-plan-stage is-${stage.status}`}>
            <span className="agentnew-plan-stage-marker" aria-hidden="true" />
            <div className="agentnew-plan-stage-body">
              <div className="agentnew-plan-stage-heading">
                <strong>{stage.title}</strong>
                <span>{statusText[stage.status]}</span>
              </div>
              <p>{stage.objective}</p>
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
            </div>
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
    </section>
  )
}
