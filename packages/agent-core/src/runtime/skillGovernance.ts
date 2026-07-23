export type SkillGovernanceAction = 'promote' | 'archive'

export interface SkillGovernanceOperation {
  ok: true
  action: SkillGovernanceAction
  skillId: string
  command: string
}

const MANAGED_SKILL_ID = /^sk_[a-zA-Z0-9_-]{1,92}$/

/**
 * Produce a reviewable operation without mutating disk. The packaged UI cannot
 * assume Node is installed, so execution remains owned by the audited CLI.
 */
export async function prepareSubagentSkillGovernance(input: {
  action: SkillGovernanceAction
  skillId: string
}): Promise<SkillGovernanceOperation> {
  if (input.action !== 'promote' && input.action !== 'archive') throw new Error('invalid governance action')
  if (!MANAGED_SKILL_ID.test(input.skillId)) throw new Error('invalid managed skill id')
  return {
    ok: true,
    action: input.action,
    skillId: input.skillId,
    command: `npm run subagent:skills -- --${input.action} ${input.skillId} --write`,
  }
}
