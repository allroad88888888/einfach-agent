export interface ComposerSubmissionOutcome {
  readonly accepted: boolean
  readonly error?: string
}

export function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && 'then' in value
}

export function composerSubmissionOutcome(value: unknown): ComposerSubmissionOutcome {
  if (typeof value === 'object' && value !== null && 'accepted' in value) {
    const result = value as { accepted?: unknown; error?: unknown }
    return { accepted: result.accepted === true, error: typeof result.error === 'string' ? result.error : undefined }
  }
  return { accepted: false }
}
