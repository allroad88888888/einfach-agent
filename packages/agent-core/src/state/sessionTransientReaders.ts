import { defaultCore, type CoreInstance } from '../runtime/core/coreInstance'
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
 * 该会话是否已「一律允许」某危险工具。MCP 工具始终不能获得 session 级授权。
 */
export function isToolAlwaysAllowed(
  id: string,
  toolName: string,
  core: CoreInstance = defaultCore,
): boolean {
  if (toolName.startsWith('mcp__')) return false
  return core.getSessionStore(id).store.getter(alwaysAllowedToolsAtom).includes(toolName)
}
