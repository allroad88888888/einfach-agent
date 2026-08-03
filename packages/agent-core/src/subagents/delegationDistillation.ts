import {
  FINISH_REASON_ERRORS,
  isAbnormalFinishReason,
} from '../runtime/core/plugins/finishReasonPlugin'
import type { SkillDistillChat } from './distill'
import type { ChildModelCaller, CallModelObservation } from './childModelClient'
import { firstAssistantText } from './childModelClient'
import type { DelegationCallState } from './runtimeState'

/** Makes the no-tool model call used to distill a delegation core and child briefs. */
export function createSkillDistillChat(callModel: ChildModelCaller): (
  state: DelegationCallState,
  input: Parameters<SkillDistillChat>[0],
  maxModelCalls: number,
  observe?: CallModelObservation,
) => Promise<string> {
  return async (state, input, maxModelCalls, observe) => {
    const phase: CallModelObservation['phase'] = input.purpose === 'core'
      ? 'distill:core'
      : 'distill:child_brief'
    const response = await callModel(state, {
      messages: [
        { role: 'system', content: input.system },
        { role: 'user', content: input.user },
      ],
      toolChoice: 'none',
      observe: observe ? { ...observe, agentPath: input.agentPath, phase } : undefined,
    }, maxModelCalls)
    const base = firstAssistantText(response) || `# ${input.purpose}\n\nNo distilled content returned.`
    const finishReason = response.choices?.[0]?.finish_reason ?? null
    if (!isAbnormalFinishReason(finishReason)) return base
    return [
      base,
      '',
      `> ${FINISH_REASON_ERRORS[finishReason]}`,
      '> 本 skill 内容不完整，不得当作完整约束执行；缺失部分请回到父 agent 澄清后再动手。',
    ].join('\n')
  }
}
