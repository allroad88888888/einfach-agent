import { useAtom } from '@einfach/react'
import { useAgentAtomValue } from '@einfach-agent/react-plugin'
import { planAtom } from '@einfach-agent/core'
import { Trans, useLingui } from '@lingui/react/macro'
import { completedPlanRecordExpandedAtom, expandedPlanStagesAtom } from './planViewState'

/** Renders a completed plan as a compact, expandable transcript record. */
export function CompletedPlanRecord() {
  const { t } = useLingui()
  const plan = useAgentAtomValue(planAtom)
  const [recordExpanded, setRecordExpanded] = useAtom(completedPlanRecordExpandedAtom)
  const [expandedStages, setExpandedStages] = useAtom(expandedPlanStagesAtom)

  if (plan?.status !== 'completed') return null

  const contentId = `agentnew-completed-plan-${plan.id}`
  const completedCount = plan.stages.filter((stage) => stage.status === 'completed').length

  return (
    <section className="agentnew-plan" aria-labelledby={`${contentId}-title`}>
      <header className="agentnew-plan-header">
        <div>
          <span className="agentnew-plan-eyebrow"><Trans>计划记录</Trans></span>
          <h2 id={`${contentId}-title`} className="agentnew-plan-title">{plan.title}</h2>
          {recordExpanded ? <p className="agentnew-plan-objective">{plan.objective}</p> : null}
        </div>
        <div className="agentnew-plan-header-actions">
          <span className="agentnew-plan-status is-completed">
            <Trans>{completedCount}/{plan.stages.length} 阶段完成</Trans>
          </span>
          <button
            type="button"
            className="agentnew-plan-toggle"
            aria-expanded={recordExpanded}
            aria-controls={contentId}
            aria-label={recordExpanded ? t`收起计划记录` : t`查看计划记录`}
            onClick={() => setRecordExpanded((current) => !current)}
          >
            {recordExpanded ? <Trans>收起</Trans> : <Trans>查看记录</Trans>}
          </button>
        </div>
      </header>

      {recordExpanded ? (
        <div id={contentId} className="agentnew-plan-content">
          <ol className="agentnew-plan-stages">
            {plan.stages.map((stage) => {
              const stageKey = `${plan.id}:completed:${stage.id}`
              const stageExpanded = expandedStages[stageKey] ?? false
              return (
                <li key={stage.id} className="agentnew-plan-stage is-completed">
                  <span className="agentnew-plan-stage-marker" aria-hidden="true" />
                  <div className="agentnew-plan-stage-card">
                    <details className="agentnew-plan-stage-details" open={stageExpanded}>
                      <summary
                        className="agentnew-plan-stage-heading"
                        onClick={(event) => {
                          event.preventDefault()
                          setExpandedStages((current) => ({
                            ...current,
                            [stageKey]: !stageExpanded,
                          }))
                        }}
                      >
                        <strong>{stage.title}</strong>
                        <span className="agentnew-plan-stage-status-actions"><span><Trans>已完成</Trans></span></span>
                        <i aria-hidden="true">⌄</i>
                      </summary>
                      {stageExpanded ? (
                        <div className="agentnew-plan-stage-body">
                          <p>{stage.objective}</p>
                          <div className="agentnew-plan-stage-meta">
                            <div>
                              <strong><Trans>交付物</Trans></strong>
                              {stage.deliverables.length > 0
                                ? <ul>{stage.deliverables.map((item) => <li key={item}>{item}</li>)}</ul>
                                : <span><Trans>未单独指定</Trans></span>}
                            </div>
                          </div>
                          {stage.result ? (
                            <div className="agentnew-plan-stage-result" aria-label={t`${stage.title}阶段产出`}>
                              {stage.result.summary}
                            </div>
                          ) : null}
                          {stage.evidence.length > 0 ? (
                            <div className="agentnew-plan-evidence">
                              <Trans>证据：{stage.evidence.join(t`；`)}</Trans>
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </details>
                  </div>
                </li>
              )
            })}
          </ol>
        </div>
      ) : null}
    </section>
  )
}
