import {
  answerQuestion,
  approvePlan,
  confirmTool,
  resumeWithAnswers,
} from '@web-agent/core/runtime/commands'
import { normalizeAskUserQuestionPayload } from '@web-agent/core/runtime/askUserQuestion'
import type { RunState } from '@web-agent/core/state/core.type'
import type { TextOutput } from './event-renderer'

export interface ReadlineBridge {
  question(prompt: string): Promise<string>
  close(): void
}

export interface ReplOptions {
  output: TextOutput
  reader: ReadlineBridge
  runPrompt(prompt: string, reader: ReadlineBridge): Promise<void>
}

interface WaitingCommands {
  answerQuestion(questionId: string, answer: string): void
  approvePlan(approved: boolean): void
  confirmTool(approved: boolean): void
  resumeWithAnswers(): void
}

const defaultWaitingCommands: WaitingCommands = {
  answerQuestion,
  approvePlan,
  confirmTool,
  resumeWithAnswers,
}

function isYes(value: string): boolean {
  return ['y', 'yes', '是'].includes(value.trim().toLowerCase())
}

/** Writes a compact terminal description for a runtime waiting state. */
export function renderWaitingState(run: RunState, output: TextOutput): boolean {
  if (run.status === 'waiting_user') {
    const questions = normalizeAskUserQuestionPayload(run.pendingUserDecision?.payload ?? run.pendingQuestion).questions
    for (const question of questions) {
      const choices = question.options?.length ? `（${question.options.join(' / ')}）` : ''
      output.write(`[ask] ${question.text}${choices}\n`)
    }
    return true
  }
  if (run.status === 'waiting_plan_approval') {
    output.write('[plan] 是否批准计划？[y/N]\n')
    return true
  }
  if (run.status === 'waiting_confirmation') {
    const name = run.pendingToolConfirmation?.toolName ?? '危险工具'
    output.write(`[tool] ${name} 需要确认，是否执行？[y/N]\n`)
    return true
  }
  return false
}

/** Renders a waiting state and restores it through the existing core commands. */
export async function resumeWaitingRun(
  run: RunState,
  reader: ReadlineBridge,
  output: TextOutput,
  commands: WaitingCommands = defaultWaitingCommands,
): Promise<boolean> {
  if (!renderWaitingState(run, output)) return false
  if (run.status === 'waiting_user') {
    const questions = normalizeAskUserQuestionPayload(run.pendingUserDecision?.payload ?? run.pendingQuestion).questions
    for (const question of questions) {
      const answer = await reader.question('> ')
      commands.answerQuestion(question.id, answer)
    }
    commands.resumeWithAnswers()
    return true
  }
  const answer = await reader.question('> ')
  if (run.status === 'waiting_plan_approval') commands.approvePlan(isYes(answer))
  else commands.confirmTool(isYes(answer))
  return true
}

/** Runs the terminal input loop; EOF and /exit end the REPL. */
export async function runRepl(options: ReplOptions): Promise<void> {
  try {
    for (;;) {
      const input = (await options.reader.question('> ')).trim()
      if (!input || input === '/exit' || input === '/quit') return
      await options.runPrompt(input, options.reader)
    }
  } finally {
    options.reader.close()
  }
}
