import { describe, expect, it } from 'vitest'
import { createMainArchitectPlan } from './main-architect'
import { mergeArtifacts } from './deputy-architect'
import { runWorkerTask } from './workers'
import { readSkill } from '../skills/registry'
import { loadTool } from '../tools/registry'
import type { AgentContext, LoadedSkill, LoadedTool } from '../runtime/types'

function createContext(input: string, overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    sessionId: 'session-test',
    runId: 'run-test',
    input,
    loadedSkills: [readSkill('web-chat-agent')].filter(Boolean) as LoadedSkill[],
    loadedTools: [loadTool('delegate_agent')].filter(Boolean) as LoadedTool[],
    ...overrides,
  }
}

describe('agent orchestration units', () => {
  it('main architect creates independent worker tasks', () => {
    const plan = createMainArchitectPlan('设计 web agent')

    expect(plan.summary).toContain('设计 web agent')
    expect(plan.tasks.map((task) => task.agentId)).toEqual([
      'skill-worker',
      'tool-worker',
      'clarifier-worker',
      'answer-worker',
    ])
  })

  it('workers return structured artifacts for skills, tools, clarification, and answer', async () => {
    const context = createContext('做一个 web agent')

    await expect(
      runWorkerTask({ id: 'skill', agentId: 'skill-worker', instruction: 'scan skills' }, context),
    ).resolves.toMatchObject({
      agentId: 'skill-worker',
      summary: expect.stringContaining('Loaded skills'),
    })

    await expect(
      runWorkerTask({ id: 'tool', agentId: 'tool-worker', instruction: 'scan tools' }, context),
    ).resolves.toMatchObject({
      agentId: 'tool-worker',
      summary: expect.stringContaining('Loaded tools'),
    })

    await expect(
      runWorkerTask({ id: 'answer', agentId: 'answer-worker', instruction: 'draft answer' }, context),
    ).resolves.toMatchObject({
      agentId: 'answer-worker',
      proposedAnswer: expect.stringContaining('运行结果'),
    })
    const answerArtifact = await runWorkerTask(
      { id: 'answer-clean', agentId: 'answer-worker', instruction: 'draft answer' },
      context,
    )
    expect(answerArtifact.proposedAnswer).toContain('已根据当前输入')
    expect(answerArtifact.proposedAnswer).not.toContain('总架构师')
    expect(answerArtifact.proposedAnswer).not.toContain('次架构师')
  })

  it('clarifier asks only when the request is materially ambiguous', async () => {
    const greeting = await runWorkerTask(
      { id: 'clarifier', agentId: 'clarifier-worker', instruction: 'clarify' },
      createContext('hi'),
    )
    expect(greeting.questions).toBeUndefined()

    const ambiguous = await runWorkerTask(
      { id: 'clarifier', agentId: 'clarifier-worker', instruction: 'clarify' },
      createContext('随便优化一下'),
    )
    expect(ambiguous.questions).toBeUndefined()
    expect(ambiguous.summary).toContain('model tool planning must decide')
    expect(ambiguous.findings).toContain('Clarification candidate: ask_user_question may be useful.')

    const answered = await runWorkerTask(
      { id: 'clarifier', agentId: 'clarifier-worker', instruction: 'clarify' },
      createContext('随便优化一下', {
        answerContext: {
          execution_scope: '先拆模块',
        },
      }),
    )
    expect(answered.questions).toBeUndefined()
  })

  it('answer worker returns a direct greeting for greeting-only input', async () => {
    const artifact = await runWorkerTask(
      { id: 'answer', agentId: 'answer-worker', instruction: 'draft answer' },
      createContext('hi'),
    )

    expect(artifact.proposedAnswer).toContain('Hi')
    expect(artifact.proposedAnswer).toContain('可以帮你')
  })

  it('deputy architect only merges artifacts and never executes AskUserQuestion directly', () => {
    expect(
      mergeArtifacts([
        {
          agentId: 'clarifier-worker',
          summary: 'needs input',
          questions: [
            {
              id: 'q',
              questions: [{ id: 'scope', text: 'scope?', type: 'text' }],
            },
          ],
          confidence: 0.8,
        },
      ]),
    ).toMatchObject({
      answer: expect.stringContaining('基础确认结果'),
      summary: 'DeputyArchitectAgent merged worker artifacts into a final answer.',
    })
    expect(mergeArtifacts([]).answer).not.toContain('次架构师')

    expect(
      mergeArtifacts([
        {
          agentId: 'answer-worker',
          summary: 'done',
          proposedAnswer: 'final answer',
          confidence: 0.9,
        },
      ]),
    ).toMatchObject({
      answer: 'final answer',
    })
  })
})
