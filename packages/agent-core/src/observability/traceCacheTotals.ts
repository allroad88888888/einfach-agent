import { createTraceLogReader, type TraceLogSnapshot } from './logReader'
import type { ContextCacheTotals } from '../state/contextStats'

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Aggregates provider cache usage recorded for one run in the local trace. */
export function cacheTotalsFromTrace(
  snapshot: TraceLogSnapshot,
  runId: string,
): ContextCacheTotals | undefined {
  let measuredRequests = 0
  let hitTokens = 0
  let missTokens = 0

  for (const span of snapshot.spans) {
    if (span.name !== 'llm.chat' || span.attrs?.runId !== runId) continue
    const hit = finiteNumber(span.attrs.cache_hit_tk)
    const miss = finiteNumber(span.attrs.cache_miss_tk)
    if (hit === undefined || miss === undefined) continue
    measuredRequests += 1
    hitTokens += hit
    missTokens += miss
  }

  if (measuredRequests === 0) return undefined
  const total = hitTokens + missTokens
  return {
    runId,
    measuredRequests,
    hitTokens,
    missTokens,
    hitRate: total > 0 ? hitTokens / total : undefined,
  }
}

/** Reads the local trace only when a legacy in-memory cache total needs recovery. */
export async function recoverCacheTotalsFromTrace(runId: string): Promise<ContextCacheTotals | undefined> {
  const reader = await createTraceLogReader()
  return cacheTotalsFromTrace(await reader.readAll(), runId)
}
