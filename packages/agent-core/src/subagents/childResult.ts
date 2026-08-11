import type { ChildAgentResult } from './types'

/** Shapes a completed child result consistently for both success and failure paths. */
export function createChildResult(
  status: ChildAgentResult['status'],
  base: Pick<ChildAgentResult, 'path' | 'objective' | 'summary' | 'skillFiles' | 'skillIds' | 'changeSets'>,
  extra: Omit<ChildAgentResult, 'path' | 'status' | 'objective' | 'summary' | 'skillFiles' | 'skillIds' | 'changeSets'>,
): ChildAgentResult {
  return { status, ...base, ...extra }
}
