import type { ConversationItem } from '../../state/core.type'
import { isDangerousTool } from '../dangerousTools'

const SIDE_EFFECT_TOOL_NAMES = new Set(['run_task'])

export function currentTurnStartIndex(items: ConversationItem[]): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].item.role === 'user') return index
  }
  return -1
}

export function currentTurnHasSideEffects(items: ConversationItem[]): boolean {
  return items.some(({ item }) => item.role === 'assistant' && (item.tool_calls ?? []).some((call) =>
    isDangerousTool(call.function.name) || SIDE_EFFECT_TOOL_NAMES.has(call.function.name)))
}
