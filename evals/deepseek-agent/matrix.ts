import {
  DEEPSEEK_FLASH_MODEL,
  DEEPSEEK_PRO_MODEL,
  type DeepSeekReasoningEffort,
} from '@web-agent/ai'

export const DEEPSEEK_EVAL_MODELS = [
  DEEPSEEK_PRO_MODEL,
  DEEPSEEK_FLASH_MODEL,
] as const

export interface DeepSeekEvalCase {
  id: string
  model: (typeof DEEPSEEK_EVAL_MODELS)[number]
  thinking: boolean
  effort: DeepSeekReasoningEffort | null
  stream: boolean
  toolCall: boolean
}

export function createDeepSeekProtocolMatrix(): DeepSeekEvalCase[] {
  return DEEPSEEK_EVAL_MODELS.flatMap((model) =>
    [false, true].flatMap((thinking) =>
      [false, true].flatMap((stream) =>
        [false, true].map((toolCall) => ({
          id: [
            model.endsWith('-pro') ? 'pro' : 'flash',
            thinking ? 'thinking' : 'non-thinking',
            stream ? 'stream' : 'non-stream',
            toolCall ? 'tool' : 'chat',
          ].join('/'),
          model,
          thinking,
          // high 同时兼容当前 adapter 与 DeepSeek V4；协议修正为 high|max 后可扩展 effort 轴。
          effort: thinking ? 'high' : null,
          stream,
          toolCall,
        })),
      ),
    ),
  )
}

export function createDeepSeekMaxTargetedCases(): DeepSeekEvalCase[] {
  return [
    {
      id: 'targeted-max/pro/non-stream/tool',
      model: DEEPSEEK_PRO_MODEL,
      thinking: true,
      effort: 'max',
      stream: false,
      toolCall: true,
    },
    {
      id: 'targeted-max/flash/stream/chat',
      model: DEEPSEEK_FLASH_MODEL,
      thinking: true,
      effort: 'max',
      stream: true,
      toolCall: false,
    },
  ]
}
