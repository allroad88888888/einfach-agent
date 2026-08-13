import { describe, expect, it } from 'vitest'
import type { RunState } from '@web-agent/core/state/core.type'
import { resumeWaitingRun, type ReadlineBridge } from './repl'

function readerWith(answers: string[]): ReadlineBridge {
  return {
    question: async () => answers.shift() ?? '',
    close: () => {},
  }
}

describe('resumeWaitingRun', () => {
  it('将 ask_user_question 的回答交给既有命令恢复', async () => {
    const output: string[] = []
    const calls: string[] = []
    const run: RunState = {
      runId: 'run-1', status: 'waiting_user', pendingQuestion: {
        questions: [{ id: 'answer', text: '继续吗？', type: 'confirm' }],
      },
    }

    await expect(resumeWaitingRun(run, readerWith(['是']), { write: (line) => output.push(line) }, {
      answerQuestion: (id, answer) => calls.push(`${id}:${answer}`),
      approvePlan: () => {}, confirmTool: () => {}, resumeWithAnswers: () => calls.push('resume'),
    })).resolves.toBe(true)
    expect(output).toEqual(['[ask] 继续吗？\n'])
    expect(calls).toEqual(['answer:是', 'resume'])
  })

  it('识别计划审批与危险工具确认两种 waiting 状态', async () => {
    const output = { write: () => {} }
    const calls: string[] = []
    const plan: RunState = { runId: 'plan', status: 'waiting_plan_approval', pendingPlanApproval: { callId: 'c', planId: 'p', revision: 1 } }
    const tool: RunState = { runId: 'tool', status: 'waiting_confirmation', pendingToolConfirmation: { callId: 'c', toolName: 'shell', args: {} } }

    const commands = {
      answerQuestion: () => {}, resumeWithAnswers: () => {},
      approvePlan: (approved: boolean) => calls.push(`plan:${approved}`),
      confirmTool: (approved: boolean) => calls.push(`tool:${approved}`),
    }
    await expect(resumeWaitingRun(plan, readerWith(['y']), output, commands)).resolves.toBe(true)
    await expect(resumeWaitingRun(tool, readerWith(['n']), output, commands)).resolves.toBe(true)
    expect(calls).toEqual(['plan:true', 'tool:false'])
  })
})
