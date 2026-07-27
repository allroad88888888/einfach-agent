import { describe, expect, it } from 'vitest'
import {
  createDeepSeekMaxTargetedCases,
  createDeepSeekProtocolMatrix,
} from './matrix'
import { writeDeepSeekResults } from './report'
import { runDeepSeekEvalCase } from './runner'

const LIVE_ENABLED = process.env.DEEPSEEK_LIVE_SMOKE === '1'

describe.skipIf(!LIVE_ENABLED)('DeepSeek live protocol smoke', () => {
  it('runs the explicit opt-in matrix and writes JSONL evidence', async () => {
    const apiKey = process.env.DEEPSEEK_API_KEY?.trim()
    if (!apiKey) {
      throw new Error('DEEPSEEK_API_KEY is required when DEEPSEEK_LIVE_SMOKE=1.')
    }
    const timeoutMs = Number(process.env.DEEPSEEK_SMOKE_CASE_TIMEOUT_MS ?? 180_000)
    const results = []
    const testCases = [
      ...createDeepSeekProtocolMatrix(),
      ...createDeepSeekMaxTargetedCases(),
    ]
    for (const testCase of testCases) {
      results.push(await runDeepSeekEvalCase(testCase, {
        apiKey,
        baseUrl: process.env.DEEPSEEK_BASE_URL,
        signal: AbortSignal.timeout(timeoutMs),
      }))
    }
    const resultPath = await writeDeepSeekResults(
      results,
      process.env.DEEPSEEK_SMOKE_RESULT_PATH,
    )
    console.info(`DeepSeek smoke evidence: ${resultPath}`)
    expect(
      results.filter((result) => !result.success),
      'See the JSONL evidence path above for protocol/transport details.',
    ).toEqual([])
    expect(
      results
        .filter((result) =>
          result.request_shapes.length !== result.request_count ||
          result.request_shapes.some((shape) => !shape.body_parseable)
        )
        .map((result) => result.case_id),
      'Every live request must emit parseable, redacted request-shape evidence.',
    ).toEqual([])
  }, 50 * 60 * 1_000)
})
