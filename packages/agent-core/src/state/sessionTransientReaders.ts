import { defaultCore, type CoreInstance } from '../runtime/core/coreInstance'
import { canRememberToolApproval } from '../runtime/sessionApprovalMemory'
import {
  alwaysAllowedToolsAtom,
  pendingQuestionAnswersAtom,
  transcriptInjectionFingerprintsAtom,
} from './sessionTransientAtoms'
import type { AskUserAnswerValue, TranscriptInjectionFingerprints } from './sessionTransientPayloads'

/**
 * 读取该会话已收集的 AskUserQuestion 答案（无答案时为空对象）。
 * core 默认 defaultCore：不传时读默认实例；传入独立 core 时只读该实例自己的 session store。
 */
export function getPendingQuestionAnswers(
  id: string,
  core: CoreInstance = defaultCore,
): Record<string, AskUserAnswerValue> {
  return core.getSessionStore(id).store.getter(pendingQuestionAnswersAtom)
}

/**
 * 读取该会话注入卡片的当前判重指纹（未记录过任何一类时为空对象）。
 */
export function getTranscriptInjectionFingerprints(
  id: string,
  core: CoreInstance = defaultCore,
): TranscriptInjectionFingerprints {
  return core.getSessionStore(id).store.getter(transcriptInjectionFingerprintsAtom)
}

/**
 * 该会话是否已「一律允许」某危险工具。
 *
 * 无记忆资格的工具（MCP 工具、连接工具）始终拿不到 session 级授权：这里在读取时再判一次，
 * 即使 atom 已被污染也不认账。判据单点见 runtime/sessionApprovalMemory.ts。
 */
export function isToolAlwaysAllowed(
  id: string,
  toolName: string,
  core: CoreInstance = defaultCore,
): boolean {
  if (!canRememberToolApproval(toolName)) return false
  return core.getSessionStore(id).store.getter(alwaysAllowedToolsAtom).includes(toolName)
}
