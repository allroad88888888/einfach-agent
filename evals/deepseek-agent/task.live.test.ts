import { describe, expect, it } from 'vitest'
import { summarizeDeepSeekTaskResults, writeDeepSeekTaskResults } from './task-report'
import { runDeepSeekTaskSuite } from './task-runner'

const LIVE_ENABLED = process.env.DEEPSEEK_TASK_AB === '1'

describe.skipIf(!LIVE_ENABLED)('DeepSeek live task A/B', () => {
  it('runs paired Pro/Flash tasks without fallback and writes JSONL evidence', async () => {
    const apiKey = process.env.DEEPSEEK_API_KEY?.trim()
    if (!apiKey) {
      throw new Error('DEEPSEEK_API_KEY is required when DEEPSEEK_TASK_AB=1.')
    }
    const repeats = Number.parseInt(process.env.DEEPSEEK_TASK_REPEATS ?? '1', 10)
    const results = await runDeepSeekTaskSuite({
      apiKey,
      baseUrl: process.env.DEEPSEEK_BASE_URL,
      repeats,
      caseTimeoutMs: Number(
        process.env.DEEPSEEK_TASK_CASE_TIMEOUT_MS ?? 180_000,
      ),
    })
    const resultPath = await writeDeepSeekTaskResults(
      results,
      process.env.DEEPSEEK_TASK_RESULT_PATH,
    )
    const summary = summarizeDeepSeekTaskResults(results)
    console.info(`DeepSeek task A/B evidence: ${resultPath}`)
    console.info(`DeepSeek task A/B summary: ${JSON.stringify(summary)}`)

    expect(results).toHaveLength(10 * 2 * Math.max(1, repeats))
    expect(
      results.filter((result) => result.error?.kind === 'transport'),
      'Transport/protocol failures are not quality scores; inspect the JSONL evidence path.',
    ).toEqual([])
    expect(summary.tool_schema_errors).toBe(0)
    expect(summary.unexpected_tools).toBe(0)
    expect(summary.duplicate_exact_tool_calls).toBe(0)
    expect(
      summary.release_gate,
      `Release gate failed: ${summary.release_gate.failure_reasons.join(', ')}`,
    ).toMatchObject({
      pass: true,
      failure_reasons: [],
    })
  }, 60 * 60 * 1_000)
})
