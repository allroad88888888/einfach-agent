import { describe, expect, it } from 'vitest'
import {
  dedupEpochInvalidations,
  f1PerRun,
  f6ToolSetSteps,
  weightedHitRate,
  prefixStability,
  stripTruncationTail,
} from './lib.js'

describe('dedupEpochInvalidations', () => {
  it('同一 (scope, epoch) 的多条 snapshot 只计一次,initial 不计失效', () => {
    const rows = [
      { cache_lane_scope_fingerprint: 's1', cache_epoch: 1, cache_epoch_reason: 'initial' },
      { cache_lane_scope_fingerprint: 's1', cache_epoch: 2, cache_epoch_reason: 'compaction_projection_changed' },
      { cache_lane_scope_fingerprint: 's1', cache_epoch: 2, cache_epoch_reason: 'compaction_projection_changed' },
      { cache_lane_scope_fingerprint: 's1', cache_epoch: 3, cache_epoch_reason: 'dynamic_control_changed' },
      { cache_lane_scope_fingerprint: 's2', cache_epoch: 2, cache_epoch_reason: 'compaction_projection_changed' },
    ]
    expect(dedupEpochInvalidations(rows)).toEqual({
      compaction_projection_changed: 2,
      dynamic_control_changed: 1,
    })
  })
})

describe('f1PerRun', () => {
  it('按 run 聚合压缩/延伸/复用并计算每次重压摊到的复用轮数', () => {
    const rows = [
      { run_id: 'r1', name: 'llm.context_compacted' },
      { run_id: 'r1', name: 'llm.context_projection_extended' },
      { run_id: 'r1', name: 'llm.context_projection_reused' },
      { run_id: 'r1', name: 'llm.context_projection_reused' },
      { run_id: 'r1', name: 'llm.context_projection_reused' },
      { run_id: 'r1', name: 'llm.context_projection_reused' },
      { run_id: 'r1', name: 'llm.context_projection_reused' },
      { run_id: 'r1', name: 'llm.context_projection_reused' },
      { run_id: 'r2', name: 'llm.context_projection_reused' },
    ]
    const result = f1PerRun(rows)
    expect(result[0]).toEqual({ runId: 'r1', compacted: 1, extended: 1, reused: 6, reusePerRebuild: 3 })
    expect(result[1].runId).toBe('r2')
  })
})

describe('f6ToolSetSteps', () => {
  it('按 tool_set_fingerprint 去重统计每 run 步数', () => {
    const rows = [
      { run_id: 'r1', tool_set_fingerprint: 'a', tools_count: 1 },
      { run_id: 'r1', tool_set_fingerprint: 'a', tools_count: 1 },
      { run_id: 'r1', tool_set_fingerprint: 'b', tools_count: 5 },
      { run_id: 'r2', tool_set_fingerprint: 'a', tools_count: 3 },
    ]
    const result = f6ToolSetSteps(rows)
    expect(result.perRun).toEqual([
      { runId: 'r1', steps: 2, maxTools: 5 },
      { runId: 'r2', steps: 1, maxTools: 3 },
    ])
    expect(result.meanSteps).toBe(1.5)
    expect(result.maxSteps).toBe(2)
  })
})

describe('weightedHitRate', () => {
  it('按 token 加权而不是按轮数', () => {
    const rows = [
      { cache_hit_tk: 90, cache_miss_tk: 10 },
      { cache_hit_tk: 0, cache_miss_tk: 100 },
    ]
    expect(weightedHitRate(rows)).toEqual({ hitTokens: 90, missTokens: 110, hitRate: 0.45 })
  })
})

describe('prefixStability', () => {
  it('剥掉截断标记后逐字节对比;纯追加(未截断)不算分歧', () => {
    expect(stripTruncationTail('abc...<truncated 42 chars>')).toBe('abc')
    const rows = [
      { run_id: 'r1', llm_turn: 1, requestPreview: 'prefix-one' },
      { run_id: 'r1', llm_turn: 2, requestPreview: 'prefix-one-appended' },
    ]
    const [result] = prefixStability(rows)
    expect(result.stable).toBe(true)
    expect(result.divergences).toEqual([])
  })

  it('窗口内内容分歧要报出首个分歧字符位置', () => {
    const rows = [
      { run_id: 'r1', llm_turn: 1, requestPreview: 'same-head-AAAA...<truncated 100 chars>' },
      { run_id: 'r1', llm_turn: 2, requestPreview: 'same-head-BBBB...<truncated 200 chars>' },
    ]
    const [result] = prefixStability(rows)
    expect(result.stable).toBe(false)
    expect(result.divergences).toEqual([{ fromTurn: 1, toTurn: 2, atChar: 'same-head-'.length }])
  })

  it('回归 2026-08-04 形态:截断窗口内逐字节一致 → 稳定,供应商低命中即可归因供应商侧', () => {
    const head = 'x'.repeat(500)
    const rows = [
      { run_id: 'r1', llm_turn: 1, requestPreview: `${head}...<truncated 400209 chars>` },
      { run_id: 'r1', llm_turn: 2, requestPreview: `${head}...<truncated 406685 chars>` },
      { run_id: 'r1', llm_turn: 3, requestPreview: `${head}...<truncated 408969 chars>` },
    ]
    const [result] = prefixStability(rows)
    expect(result.stable).toBe(true)
    expect(result.windowChars).toBe(500)
  })
})
