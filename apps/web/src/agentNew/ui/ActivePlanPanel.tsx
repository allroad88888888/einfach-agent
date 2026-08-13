import { useAtomValue } from '@einfach/react'
import { planAtom } from '@web-agent/core'
import { PlanPanel } from './PlanPanel'

/** Keeps actionable plans near the composer while completed plans live in the transcript. */
export function ActivePlanPanel() {
  const plan = useAtomValue(planAtom)

  return plan?.status === 'completed' ? null : <PlanPanel />
}
