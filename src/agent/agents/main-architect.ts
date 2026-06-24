import type { MainArchitectPlan, WorkerTask } from '../runtime/types'

export function createMainArchitectPlan(input: string): MainArchitectPlan {
  const normalizedInput = input.trim()
  const tasks: WorkerTask[] = [
    {
      id: 'task-skill-scan',
      agentId: 'skill-worker',
      instruction: 'Select repository skills that should shape this run.',
    },
    {
      id: 'task-tool-scan',
      agentId: 'tool-worker',
      instruction: 'Determine the minimal lazy-loaded tools needed for this run.',
    },
    {
      id: 'task-clarifier',
      agentId: 'clarifier-worker',
      instruction: 'Identify missing decisions that would materially change the answer.',
    },
    {
      id: 'task-answer',
      agentId: 'answer-worker',
      instruction: 'Draft a concise answer from selected skills, loaded tools, and user intent.',
    },
  ]

  return {
    summary: normalizedInput
      ? `MainArchitectAgent received: ${normalizedInput}`
      : 'MainArchitectAgent received an empty request.',
    tasks,
  }
}
