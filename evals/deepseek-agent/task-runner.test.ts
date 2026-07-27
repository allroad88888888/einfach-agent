import { describe, expect, it } from 'vitest'
import { calculateDeepSeekTaskCost } from './task-cost'
import { summarizeDeepSeekTaskResults } from './task-report'
import {
  parseTaskJson,
  runDeepSeekTaskCase,
  type DeepSeekTaskAbResult,
} from './task-runner'
import {
  DEEPSEEK_TASKS,
  DEEPSEEK_TASK_LANES,
  scoreDeepSeekTask,
  shadowRouteForTask,
  taskLaneOrder,
  type DeepSeekTaskToolTraceEntry,
} from './task-suite'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function completion(
  model: string,
  message: Record<string, unknown>,
  finishReason: 'stop' | 'tool_calls' = 'stop',
): unknown {
  return {
    id: `resp-${model}`,
    model,
    choices: [{ finish_reason: finishReason, message }],
    usage: {
      prompt_tokens: 20,
      completion_tokens: 5,
      total_tokens: 25,
      prompt_cache_hit_tokens: 8,
      prompt_cache_miss_tokens: 12,
    },
  }
}

const PASSING_OUTPUTS: Record<string, {
  output: Record<string, unknown>
  trace?: DeepSeekTaskToolTraceEntry[]
}> = {
  T01: {
    output: {
      version: 'v4.7.2',
      environment: 'staging-eu',
      deadline: '2026-07-25T09:30+08:00',
      failed_checks: ['tools', 'cache'],
      owner: 'Mei',
    },
  },
  T02: {
    output: {
      events: ['detected', 'isolated', 'mitigated'],
      duration_minutes: 6,
      unique_event_count: 3,
    },
  },
  T03: {
    output: {
      tickets: {
        A: { label: 'bug', severity: 'P1' },
        B: { label: 'howto', severity: 'P3' },
        C: { label: 'billing', severity: 'P2' },
        D: { label: 'security', severity: 'P0' },
        E: { label: 'bug', severity: 'P1' },
        F: { label: 'howto', severity: 'P3' },
      },
    },
  },
  T04: {
    output: {
      changes: { A: 'safe', B: 'review', C: 'block', D: 'block', E: 'safe' },
    },
  },
  T05: {
    output: {
      nodes: ['schema', 'api', 'ui', 'verify'],
      edges: [['schema', 'api'], ['api', 'ui'], ['ui', 'verify']],
      rollback_point: 'before_api',
      planned_ops: ['add_nullable_column', 'backfill'],
      forbidden_ops: ['drop_table'],
    },
  },
  T06: {
    output: {
      phases: [5, 25, 100],
      abort_thresholds: [
        { metric: 'error_rate_percent', operator: '>', value: 2 },
        { metric: 'p95_ms', operator: '>', value: 800 },
      ],
      abort_action: 'rollback',
      rollback_target: 'previous_version',
    },
  },
  T07: {
    output: {
      root_cause: 'missing_finally',
      evidence: 'persist_rejection_skips_reset',
      patch: 'try_finally',
      regression: 'saving_false_on_reject',
    },
  },
  T08: {
    output: {
      root_cause: 'missing_idempotency',
      call_path: ['controller', 'retry', 'writer'],
      change_module: 'writer',
      regression: 'same_key_single_effect',
    },
  },
  T09: {
    output: {
      fact: 'Cache hit tokens are provider reported.',
      citation: 'doc-cache-v4#usage',
    },
    trace: [
      { name: 'fixture_search_docs', args: { query: 'cache V4 usage' } },
      { name: 'fixture_read_doc', args: { id: 'doc-cache-v4' } },
    ],
  },
  T10: {
    output: {
      status: 'failed',
      failed_check: 'typecheck',
      evidence: 'build-842#checks',
    },
    trace: [
      { name: 'fixture_lookup_build', args: { id: 'build-latest' } },
      { name: 'fixture_lookup_build', args: { id: 'build-842' } },
    ],
  },
}

describe('DeepSeek task A/B fixtures and scoring', () => {
  it('has ten deterministic tasks whose canonical answers score 100', () => {
    expect(DEEPSEEK_TASKS).toHaveLength(10)
    for (const task of DEEPSEEK_TASKS) {
      const passing = PASSING_OUTPUTS[task.id]
      expect(passing, task.id).toBeDefined()
      expect(
        scoreDeepSeekTask(task, passing!.output, passing!.trace ?? []),
        task.id,
      ).toMatchObject({
        earned: 100,
        max: 100,
        pass: true,
        hardFailures: [],
      })
    }
  })

  it('shadows only safe retrieval/extraction tasks to Flash', () => {
    const flashTasks = DEEPSEEK_TASKS
      .filter((task) => shadowRouteForTask(task).tier === 'flash')
      .map((task) => task.id)
    expect(flashTasks).toEqual(['T01', 'T09', 'T10'])
  })

  it('alternates AB/BA order by task id', () => {
    expect(taskLaneOrder('T01').map((lane) => lane.arm)).toEqual(['pro', 'flash'])
    expect(taskLaneOrder('T02').map((lane) => lane.arm)).toEqual(['flash', 'pro'])
    expect(taskLaneOrder('T01', 1).map((lane) => lane.arm)).toEqual(['flash', 'pro'])
    expect(taskLaneOrder('T02', 1).map((lane) => lane.arm)).toEqual(['pro', 'flash'])
  })

  it('treats safety-critical mistakes as hard failures', () => {
    const task = DEEPSEEK_TASKS.find((candidate) => candidate.id === 'T04')!
    const score = scoreDeepSeekTask(task, {
      changes: { A: 'safe', B: 'review', C: 'safe', D: 'block', E: 'safe' },
    }, [])
    expect(score.pass).toBe(false)
    expect(score.hardFailures).toContain('change_C_secret')
  })

  it('keeps a Flash-like T09 candidate-document read as a soft efficiency loss', () => {
    const task = DEEPSEEK_TASKS.find((candidate) => candidate.id === 'T09')!
    const score = scoreDeepSeekTask(
      task,
      PASSING_OUTPUTS.T09!.output,
      [
        { name: 'fixture_search_docs', args: { query: 'cache V4 usage' } },
        { name: 'fixture_read_doc', args: { id: 'doc-cache-legacy' } },
        { name: 'fixture_read_doc', args: { id: 'doc-cache-v4' } },
      ],
    )

    expect(score).toMatchObject({
      earned: 90,
      pass: true,
      hardFailures: [],
    })
  })
})

describe('DeepSeek task runner', () => {
  it('parses a fenced JSON object without retaining the wrapper', () => {
    expect(parseTaskJson('Answer:\n```json\n{"ok":true,"text":"}"}\n```')).toEqual({
      ok: true,
      text: '}',
    })
  })

  it('classifies an invalid balanced object as a task-output error', () => {
    expect(() => parseTaskJson('Answer: {"ok":]')).toThrow(
      'Model output did not contain a valid JSON object.',
    )
  })

  it('runs a task and records hashes, usage, route, and no raw output', async () => {
    const task = DEEPSEEK_TASKS[0]!
    const lane = DEEPSEEK_TASK_LANES[1]!
    const fetchImpl: typeof fetch = async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>
      expect(request.model).toBe('deepseek-v4-flash')
      expect(request.temperature).toBe(0)
      return jsonResponse(completion(
        'deepseek-v4-flash',
        { role: 'assistant', content: JSON.stringify(PASSING_OUTPUTS.T01!.output) },
      ))
    }
    const result = await runDeepSeekTaskCase(task, lane, {
      apiKey: 'test-key',
      fetchImpl,
      now: (() => {
        let current = 100
        return () => {
          current += 5
          return current
        }
      })(),
      runId: 'run-test',
      orderIndex: 1,
    })

    expect(result.score).toMatchObject({ earned: 100, pass: true })
    expect(result.response_model).toBe('deepseek-v4-flash')
    expect(result.schema_version).toBe('deepseek-task-ab/v2')
    expect(result.route_features.requires_temporal_normalization).toBe(false)
    expect(result.fixture_sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(result.output_sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(result.requests).toMatchObject({
      model_calls: 1,
      http_requests: 1,
      http_statuses: [200],
      finish_reasons: ['stop'],
    })
    expect(result.tokens).toEqual({
      input: 20,
      output: 5,
      total: 25,
      cache_hit: 8,
      cache_miss: 12,
      cache_miss_source: 'provider',
    })
    expect(calculateDeepSeekTaskCost(result)).toMatchObject({
      status: 'complete',
      priced_model: 'deepseek-v4-flash',
      exact_cost_pico_usd: 3_102_400,
      conservative_upper_cost_pico_usd: 4_200_000,
    })
    expect(JSON.stringify(result)).not.toContain('staging-eu')
    expect(JSON.stringify(result)).not.toContain('2026-07-25T09:30+08:00')
  })

  it('records temporal-normalization routing requirements in v2 results', async () => {
    const task = DEEPSEEK_TASKS.find((candidate) => candidate.id === 'T02')!
    const lane = DEEPSEEK_TASK_LANES[0]!
    const result = await runDeepSeekTaskCase(task, lane, {
      apiKey: 'test-key',
      fetchImpl: async () => jsonResponse(completion(
        'deepseek-v4-pro',
        { role: 'assistant', content: JSON.stringify(PASSING_OUTPUTS.T02!.output) },
      )),
      runId: 'run-temporal-route-test',
    })

    expect(result.route_features.requires_temporal_normalization).toBe(true)
    expect(JSON.stringify(result)).toContain('"requires_temporal_normalization":true')
  })

  it('executes a bounded synthetic recovery trace', async () => {
    const task = DEEPSEEK_TASKS.find((candidate) => candidate.id === 'T10')!
    const lane = DEEPSEEK_TASK_LANES[0]!
    const requests: Array<Record<string, unknown>> = []
    const responses = [
      completion('deepseek-v4-pro', {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call-1',
          type: 'function',
          function: {
            name: 'fixture_lookup_build',
            arguments: '{"id":"build-latest"}',
          },
        }],
      }, 'tool_calls'),
      completion('deepseek-v4-pro', {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call-2',
          type: 'function',
          function: {
            name: 'fixture_lookup_build',
            arguments: '{"id":"build-842"}',
          },
        }],
      }, 'tool_calls'),
      completion('deepseek-v4-pro', {
        role: 'assistant',
        content: JSON.stringify(PASSING_OUTPUTS.T10!.output),
      }),
    ]
    const fetchImpl: typeof fetch = async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return jsonResponse(responses.shift())
    }

    const result = await runDeepSeekTaskCase(task, lane, {
      apiKey: 'test-key',
      fetchImpl,
      runId: 'run-tool-test',
    })

    expect(result.error).toBeNull()
    expect(result.score).toMatchObject({ earned: 100, pass: true })
    expect(result.tools).toEqual({
      calls: 2,
      successes: 1,
      schema_errors: 0,
      unexpected: 0,
      duplicate_exact_calls: 0,
      recovery_turns: 1,
      trace: ['fixture_lookup_build', 'fixture_lookup_build'],
    })
    expect(requests).toHaveLength(3)
    expect(requests[1]?.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'tool',
        content: '{"error":"ambiguous","hint":"build-842"}',
      }),
    ]))
  })
})

describe('DeepSeek task A/B report', () => {
  it('compares shadow routing with the all-Pro baseline', () => {
    const base = {
      score: { earned: 100, max: 100, pass: true, hardFailures: [], components: {} },
      timing: { wall_ms: 10, ttft_ms: null },
      model: 'deepseek-v4-pro',
      response_model: 'deepseek-v4-pro',
      tokens: {
        input: 20,
        output: 5,
        total: 25,
        cache_hit: 8,
        cache_miss: 12,
        cache_miss_source: 'provider',
      },
      tools: {
        schema_errors: 0,
        unexpected: 0,
        duplicate_exact_calls: 0,
      },
      replicate: 0,
    } as unknown as DeepSeekTaskAbResult
    const results = [
      {
        ...base,
        task_id: 'T01',
        arm: 'pro',
        shadow_route: { tier: 'flash', reason: 'test' },
      },
      {
        ...base,
        task_id: 'T01',
        arm: 'flash',
        model: 'deepseek-v4-flash',
        response_model: 'deepseek-v4-flash',
        shadow_route: { tier: 'flash', reason: 'test' },
        score: { ...base.score, earned: 90, pass: true },
      },
      {
        ...base,
        task_id: 'T03',
        arm: 'pro',
        shadow_route: { tier: 'pro', reason: 'test' },
      },
      {
        ...base,
        task_id: 'T03',
        arm: 'flash',
        model: 'deepseek-v4-flash',
        response_model: 'deepseek-v4-flash',
        shadow_route: { tier: 'pro', reason: 'test' },
        score: { ...base.score, earned: 70, pass: false },
      },
    ] as DeepSeekTaskAbResult[]
    const summary = summarizeDeepSeekTaskResults(results)
    expect(summary).toMatchObject({
      runs: 4,
      pairs: 2,
      paired_pro_minus_flash_average_score: 20,
      shadow_policy: {
        runs: 2,
        passes: 2,
        pass_rate: 1,
        average_score: 95,
        passes_lost_vs_paired_pro: 0,
        cache_hit_ratio: 0.4,
        total_cost_pico_usd: 12_701_400,
        cost_per_pass_pico_usd: 6_350_700,
        total_cost_savings_ratio: 0.3384,
        cost_per_pass_savings_ratio: 0.3384,
      },
      release_gate: {
        pass: true,
        failure_reasons: [],
      },
    })
    expect(summary.arms.pro).toMatchObject({
      total_cost_pico_usd: 19_198_000,
      cost_per_pass_pico_usd: 9_599_000,
      cache_hit_ratio: 0.4,
    })
    expect(summary.arms.flash).toMatchObject({
      total_cost_pico_usd: 6_204_800,
      cost_per_pass_pico_usd: 6_204_800,
      cache_hit_ratio: 0.4,
    })
  })

  it('does not emit an exact cost when cache split or model identity is missing', () => {
    const result = {
      model: 'deepseek-v4-pro',
      response_model: 'deepseek-v4-pro',
      tokens: {
        input: 20,
        output: 5,
        total: 25,
        cache_hit: null,
        cache_miss: null,
        cache_miss_source: 'unknown',
      },
    } as DeepSeekTaskAbResult
    expect(calculateDeepSeekTaskCost(result)).toMatchObject({
      status: 'cache_split_missing',
      exact_cost_pico_usd: null,
      conservative_upper_cost_pico_usd: 13_050_000,
    })
    expect(calculateDeepSeekTaskCost({
      ...result,
      response_model: null,
    })).toMatchObject({
      // 没有任何响应 ≠ 路由到了别的模型；上界仍按请求模型给出。
      status: 'no_response',
      exact_cost_pico_usd: null,
      conservative_upper_cost_pico_usd: 13_050_000,
    })
    expect(calculateDeepSeekTaskCost({
      ...result,
      model: 'deepseek-v4-flash',
      response_model: 'deepseek-v4-pro',
    })).toMatchObject({
      status: 'model_mismatch',
      exact_cost_pico_usd: null,
      conservative_upper_cost_pico_usd: 13_050_000,
    })
  })

  it('fails the release gate on incomplete cost data without NaN metrics', () => {
    const base = {
      score: { earned: 100, max: 100, pass: true, hardFailures: [], components: {} },
      timing: { wall_ms: 10, ttft_ms: null },
      model: 'deepseek-v4-pro',
      response_model: 'deepseek-v4-pro',
      tokens: {
        input: 20,
        output: 5,
        total: 25,
        cache_hit: null,
        cache_miss: null,
        cache_miss_source: 'unknown',
      },
      tools: {
        schema_errors: 0,
        unexpected: 0,
        duplicate_exact_calls: 0,
      },
      replicate: 0,
      task_id: 'T01',
      shadow_route: { tier: 'flash', reason: 'test' },
    } as unknown as DeepSeekTaskAbResult
    const summary = summarizeDeepSeekTaskResults([
      { ...base, arm: 'pro' },
      {
        ...base,
        arm: 'flash',
        model: 'deepseek-v4-flash',
        response_model: 'deepseek-v4-flash',
      },
    ])

    expect(summary.arms.pro).toMatchObject({
      total_cost_pico_usd: null,
      conservative_upper_cost_pico_usd: 13_050_000,
      cost_per_pass_pico_usd: null,
      cache_hit_ratio: null,
    })
    expect(summary.release_gate.pass).toBe(false)
    expect(summary.release_gate.failure_reasons).toContain('incomplete_cost_data')
    expect(JSON.stringify(summary)).not.toContain('NaN')
  })
})
