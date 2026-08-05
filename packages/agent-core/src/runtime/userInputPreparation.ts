import { isAbortError, type UserMessageContent } from '@web-agent/ai'
import type { ModelSettings } from '../state/core.type'

/** Host-owned image payload. Core deliberately never reads or persists `data`. */
export interface UserInputImage {
  id: string
  name: string
  mimeType: string
  byteSize: number
  width?: number
  height?: number
  data: unknown
}

export interface UserInputSubmission {
  text: string
  images?: readonly UserInputImage[]
}

export type SendMessageInput = string | UserInputSubmission

export interface UserInputPreparationContext {
  sessionId: string
  settings: Readonly<ModelSettings>
  apiKey: string
  signal: AbortSignal
  fetchImpl?: typeof fetch
}

export type PreparedUserInputRollbackReason = Extract<
  SendMessageResult,
  { accepted: false }
>['reason']

export interface PreparedUserInput {
  content: UserMessageContent
  rollback?: (reason: PreparedUserInputRollbackReason) => void | Promise<void>
}

export type UserInputPreparer = (
  input: UserInputSubmission,
  context: UserInputPreparationContext,
) => PreparedUserInput | Promise<PreparedUserInput>

export type SendMessageResult =
  | {
      accepted: true
      status: 'started' | 'queued'
      sessionId: string
      submissionSequence: number
    }
  | {
      accepted: false
      status: 'rejected'
      reason:
        | 'empty'
        | 'session_missing'
        | 'run_blocked'
        | 'settings_changed'
        | 'prepare_failed'
        | 'prepare_aborted'
        | 'commit_failed'
      error?: string
    }

export function normalizeUserInput(input: SendMessageInput): UserInputSubmission {
  if (typeof input === 'string') return { text: input.trim() }
  return {
    text: input.text.trim(),
    ...(input.images?.length ? { images: input.images.map((image) => ({ ...image })) } : {}),
  }
}

export function hasUserInput(input: UserInputSubmission): boolean {
  return Boolean(input.text || input.images?.length)
}

export function hasPreparedUserContent(content: UserMessageContent): boolean {
  if (typeof content === 'string') return Boolean(content.trim())
  return content.some((block) => block.type === 'image' || Boolean(block.text.trim()))
}

export function defaultPrepareUserInput(input: UserInputSubmission): PreparedUserInput {
  if (input.images?.length) {
    throw new Error('No user input preparer is configured for image input.')
  }
  return { content: input.text }
}

export function preparationRejection(error: unknown): SendMessageResult {
  const aborted = isAbortError(error) || (error instanceof Error && error.name === 'AbortError')
  return {
    accepted: false,
    status: 'rejected',
    reason: aborted ? 'prepare_aborted' : 'prepare_failed',
    error: error instanceof Error ? error.message : String(error),
  }
}
