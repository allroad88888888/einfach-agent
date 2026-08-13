import { useAtom, useAtomValue } from '@einfach/react'
import { planAtom, completedPlanRecordExpandedAtom, expandedPlanStagesAtom } from '@web-agent/core'

/** Renders a completed plan as a compact, expandable transcript record. */
export function CompletedPlanRecord() {
  const plan = useAtomValue(planAtom)
  const [recordExpanded, setRecordExpanded] = useAtom(completedPlanRecordExpandedAtom)
  const [expandedStages, setExpandedStages] = useAtom(expandedPlanStagesAtom)

  if (plan?.status !== 'completed') return null

  const contentId = `agentnew-completed-plan-${plan.id}`
  const completedCount = plan.stages.filter((stage) => stage.status === 'completed').length

  return (
    <section className="agentnew-plan" aria-labelledby={`${contentId}-title`}>
      <header className="agentnew-plan-header">
        <div>
          <span className="agentnew-plan-eyebrow">计划记录</span>
          <h2 id={`${contentId}-title`} className="agentnew-plan-title">{plan.title}</h2>
          {recordExpanded ? <p className="agentnew-plan-objective">{plan.objective}</p> : null}
        </div>
        <div className="agentnew-plan-header-actions">
          <span className="agentnew-plan-status is-completed">
            {completedCount}/{plan.stages.length} 阶段完成
          </span>
          <button
            type="button"
            className="agentnew-plan-toggle"
            aria-expanded={recordExpanded}
            aria-controls={contentId}
            aria-label={recordExpanded ? '收起计划记录' : '查看计划记录'}
            onClick={() => setRecordExpanded((current) => !current)}
          >
            {recordExpanded ? '收起' : '查看记录'}
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
                        <span className="agentnew-plan-stage-status-actions"><span>已完成</span></span>
                        <i aria-hidden="true">⌄</i>
                      </summary>
                      {stageExpanded ? (
                        <div className="agentnew-plan-stage-body">
                          <p>{stage.objective}</p>
                          <div className="agentnew-plan-stage-meta">
                            <div>
                              <strong>交付物</strong>
                              {stage.deliverables.length > 0
                                ? <ul>{stage.deliverables.map((item) => <li key={item}>{item}</li>)}</ul>
                                : <span>未单独指定</span>}
                            </div>
                          </div>
                          {stage.result ? (
                            <div className="agentnew-plan-stage-result" aria-label={`${stage.title}阶段产出`}>
                              {stage.result.summary}
                            </div>
                          ) : null}
                          {stage.evidence.length > 0 ? (
                            <div className="agentnew-plan-evidence">证据：{stage.evidence.join('；')}</div>
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
