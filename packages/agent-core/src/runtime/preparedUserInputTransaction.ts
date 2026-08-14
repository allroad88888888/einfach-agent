import type {
  PreparedUserInput,
  PreparedUserInputRollbackReason,
  SendMessageResult,
} from './userInputPreparation'
import { preparationRejection } from './userInputPreparation'

type CommitPreparedInput = (prepared: PreparedUserInput['content']) => SendMessageResult | Promise<SendMessageResult>

function abortedResult(): SendMessageResult {
  return { accepted: false, status: 'rejected', reason: 'prepare_aborted' }
}

function rollbackThenReturn(
  prepared: PreparedUserInput,
  reason: PreparedUserInputRollbackReason,
  result: SendMessageResult,
): SendMessageResult | Promise<SendMessageResult> {
  if (!prepared.rollback) return result
  try {
    const rollback = prepared.rollback(reason)
    if (rollback && typeof (rollback as PromiseLike<void>).then === 'function') {
      return Promise.resolve(rollback).then(() => result, () => result)
    }
  } catch {
    // The original rejection is authoritative; cleanup failures must not mask it.
  }
  return result
}

async function settlePrepared(
  prepared: PreparedUserInput,
  commit: CommitPreparedInput,
): Promise<SendMessageResult> {
  try {
    const result = await commit(prepared.content)
    if (result.accepted) return result
    return rollbackThenReturn(prepared, result.reason, result)
  } catch (error) {
    const result: SendMessageResult = {
      accepted: false,
      status: 'rejected',
      reason: 'commit_failed',
      error: error instanceof Error ? error.message : String(error),
    }
    return rollbackThenReturn(prepared, 'commit_failed', result)
  }
}

function settleAsyncPreparation(
  preparation: PromiseLike<PreparedUserInput>,
  signal: AbortSignal,
  commit: CommitPreparedInput,
): Promise<SendMessageResult> {
  return new Promise((resolve) => {
    let cancelled = signal.aborted
    const onAbort = () => {
      if (cancelled) return
      cancelled = true
      resolve(abortedResult())
    }
    if (!cancelled) signal.addEventListener('abort', onAbort, { once: true })
    else resolve(abortedResult())

    void Promise.resolve(preparation).then(
      async (prepared) => {
        signal.removeEventListener('abort', onAbort)
        if (cancelled || signal.aborted) {
          await rollbackThenReturn(prepared, 'prepare_aborted', abortedResult())
          if (!cancelled) resolve(abortedResult())
          return
        }
        resolve(await settlePrepared(prepared, commit))
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        if (!cancelled) resolve(preparationRejection(error))
      },
    )
  })
}

/** Runs provider preparation before commit and rolls back provider resources on rejection. */
export function executePreparedUserInput(
  start: () => PreparedUserInput | Promise<PreparedUserInput>,
  signal: AbortSignal,
  commit: CommitPreparedInput,
): Promise<SendMessageResult> {
  if (signal.aborted) return Promise.resolve(abortedResult())
  try {
    const preparation = start()
    if (preparation && typeof (preparation as PromiseLike<PreparedUserInput>).then === 'function') {
      return settleAsyncPreparation(preparation as PromiseLike<PreparedUserInput>, signal, commit)
    }
    if (signal.aborted) {
      return Promise.resolve(rollbackThenReturn(preparation as PreparedUserInput, 'prepare_aborted', abortedResult()))
    }
    return settlePrepared(preparation as PreparedUserInput, commit)
  } catch (error) {
    return Promise.resolve(preparationRejection(error))
  }
}
