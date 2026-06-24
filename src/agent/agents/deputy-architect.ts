import type { AgentArtifact } from '../runtime/types'

export function mergeArtifacts(artifacts: AgentArtifact[]): {
  answer: string
  summary: string
} {
  const answerArtifact = artifacts.find((artifact) => artifact.proposedAnswer)

  return {
    answer:
      answerArtifact?.proposedAnswer ??
      '当前没有可用的回答草稿，本轮只能返回基础确认结果。',
    summary: 'DeputyArchitectAgent merged worker artifacts into a final answer.',
  }
}
