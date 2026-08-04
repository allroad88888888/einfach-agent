// 上下文缓存验收指标的纯计算层:输入 trace 行,输出 F1/F2/F6 与前缀稳定性结论。
// 不做任何 IO;数据获取与展示在 report.js。验收口径见 docs/context-cache-followups.md。

/**
 * 按 (lane scope, epoch) 去重的真实失效计数(F1 指标③ / F2 归零确认的口径)。
 * snapshot 行需含 attrs 里的 cache_lane_scope_fingerprint / cache_epoch / cache_epoch_reason。
 */
export function dedupEpochInvalidations(snapshots) {
  const seen = new Set()
  const byReason = new Map()
  for (const row of snapshots) {
    const scope = row.cache_lane_scope_fingerprint
    const epoch = row.cache_epoch
    const reason = row.cache_epoch_reason
    if (!scope || epoch === undefined || epoch === null || !reason) continue
    if (reason === 'initial') continue
    const key = `${scope}\u0000${epoch}`
    if (seen.has(key)) continue
    seen.add(key)
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1)
  }
  return Object.fromEntries([...byReason.entries()].sort((a, b) => b[1] - a[1]))
}

/** F1:每 run 的压缩/延伸/复用事件计数与「一次压缩摊多轮」的最大复用数。 */
export function f1PerRun(eventRows) {
  const runs = new Map()
  for (const row of eventRows) {
    if (!row.run_id) continue
    const entry = runs.get(row.run_id) ?? { compacted: 0, extended: 0, reused: 0 }
    if (row.name === 'llm.context_compacted') entry.compacted += 1
    else if (row.name === 'llm.context_projection_extended') entry.extended += 1
    else if (row.name === 'llm.context_projection_reused') entry.reused += 1
    runs.set(row.run_id, entry)
  }
  const result = []
  for (const [runId, entry] of runs) {
    if (entry.compacted + entry.extended + entry.reused === 0) continue
    const rebuilds = entry.compacted + entry.extended
    result.push({
      runId,
      ...entry,
      // 每次(重)压缩平均摊到的复用轮数;>1 才说明「一次压缩摊多轮」成立(验收②)。
      reusePerRebuild: rebuilds > 0 ? entry.reused / rebuilds : entry.reused,
    })
  }
  return result.sort((a, b) => b.reused - a.reused)
}

/** F6:每 run 的工具集变化步数(按 tool_set_fingerprint 去重,验收核心指标)。 */
export function f6ToolSetSteps(snapshots) {
  const runs = new Map()
  for (const row of snapshots) {
    if (!row.run_id || !row.tool_set_fingerprint) continue
    const entry = runs.get(row.run_id) ?? { fingerprints: new Set(), maxTools: 0 }
    entry.fingerprints.add(row.tool_set_fingerprint)
    entry.maxTools = Math.max(entry.maxTools, row.tools_count ?? 0)
    runs.set(row.run_id, entry)
  }
  const perRun = [...runs.entries()].map(([runId, entry]) => ({
    runId,
    steps: entry.fingerprints.size,
    maxTools: entry.maxTools,
  }))
  const steps = perRun.map((entry) => entry.steps)
  return {
    perRun: perRun.sort((a, b) => b.steps - a.steps),
    meanSteps: steps.length ? steps.reduce((a, b) => a + b, 0) / steps.length : 0,
    maxSteps: steps.length ? Math.max(...steps) : 0,
  }
}

/** 供应商侧加权命中率(F1 验收④的本地读数,与 DeepSeek 控制台对账用)。 */
export function weightedHitRate(chatSpans) {
  let hit = 0
  let miss = 0
  for (const row of chatSpans) {
    hit += row.cache_hit_tk ?? 0
    miss += row.cache_miss_tk ?? 0
  }
  const total = hit + miss
  return { hitTokens: hit, missTokens: miss, hitRate: total > 0 ? hit / total : undefined }
}

const TRUNCATION_TAIL = /\.\.\.<truncated \d+ chars>\s*$/

/** 去掉 requestPreview 末尾的截断标记,留下真实发送内容的前缀窗口。 */
export function stripTruncationTail(preview) {
  return typeof preview === 'string' ? preview.replace(TRUNCATION_TAIL, '') : ''
}

function firstDiffIndex(a, b) {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i += 1) {
    if (a[i] !== b[i]) return i
  }
  return a.length === b.length ? -1 : n
}

/**
 * 我们侧前缀稳定性断言(回归观察文档「后续排查①」的替代实现):
 * 同一 run 相邻两轮请求的 preview 窗口内必须逐字节一致。
 * 供应商报告的低命中若发生在此窗口内,即可判定为供应商侧因素而非本地请求不稳定。
 */
export function prefixStability(chatSpans) {
  const byRun = new Map()
  for (const row of chatSpans) {
    if (!row.run_id || typeof row.requestPreview !== 'string') continue
    const list = byRun.get(row.run_id) ?? []
    list.push(row)
    byRun.set(row.run_id, list)
  }
  const results = []
  for (const [runId, rows] of byRun) {
    rows.sort((a, b) => (a.llm_turn ?? 0) - (b.llm_turn ?? 0))
    let stable = true
    let windowChars = Number.POSITIVE_INFINITY
    const divergences = []
    for (let i = 1; i < rows.length; i += 1) {
      const prev = stripTruncationTail(rows[i - 1].requestPreview)
      const next = stripTruncationTail(rows[i].requestPreview)
      const window = Math.min(prev.length, next.length)
      windowChars = Math.min(windowChars, window)
      const diff = firstDiffIndex(prev, next)
      // 短请求(未触发截断)后一轮追加历史属正常;只有窗口内分歧才是前缀被改写。
      if (diff !== -1 && diff < window) {
        stable = false
        divergences.push({ fromTurn: rows[i - 1].llm_turn, toTurn: rows[i].llm_turn, atChar: diff })
      }
    }
    results.push({
      runId,
      turns: rows.length,
      stable,
      windowChars: Number.isFinite(windowChars) ? windowChars : 0,
      divergences,
    })
  }
  return results
}

/** 多因子归因:统计逐轮 cache_epoch_causes(逗号分隔,非互斥)的出现次数。 */
export function epochCauseCounts(snapshots) {
  const counts = new Map()
  for (const row of snapshots) {
    if (typeof row.cache_epoch_causes !== 'string' || !row.cache_epoch_causes) continue
    for (const cause of row.cache_epoch_causes.split(',')) {
      counts.set(cause, (counts.get(cause) ?? 0) + 1)
    }
  }
  return Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1]))
}

const REQUEST_CONTROL_SOURCES = ['plan_snapshot', 'plan_continuation', 'tool_failure_notice', 'unknown']

/**
 * 把相邻 context_snapshot 的脱敏组装字段归为具体来源。
 * 只使用 fingerprint、数量与公开工具名，不读取 prompt 或 requestPreview。
 */
export function requestAssemblyChanges(snapshots) {
  const byRun = new Map()
  for (const row of snapshots) {
    if (!row.run_id || !row.cache_assembly_raw_fingerprint) continue
    const list = byRun.get(row.run_id) ?? []
    list.push(row)
    byRun.set(row.run_id, list)
  }
  const changes = []
  for (const [runId, rows] of byRun) {
    rows.sort((left, right) => (left.llm_turn ?? 0) - (right.llm_turn ?? 0))
    for (let index = 1; index < rows.length; index += 1) {
      const previous = rows[index - 1]
      const current = rows[index]
      const causes = []
      if (previous.cache_assembly_stable_prefix_fingerprint !== current.cache_assembly_stable_prefix_fingerprint) causes.push({ type: 'stable_prefix' })
      for (const source of REQUEST_CONTROL_SOURCES) {
        const field = `cache_assembly_control_${source}_fingerprint`
        if (previous[field] !== current[field]) causes.push({ type: 'dynamic_control', source })
      }
      if (previous.cache_assembly_tool_names !== current.cache_assembly_tool_names) {
        causes.push({ type: 'tool_membership', from: previous.cache_assembly_tool_names, to: current.cache_assembly_tool_names })
      } else if (previous.cache_assembly_tools_fingerprint !== current.cache_assembly_tools_fingerprint) {
        causes.push({ type: 'tool_schema' })
      }
      if (current.cache_assembly_transform_changed) causes.push({ type: 'transform_context' })
      if (current.cache_assembly_prepare_changed) causes.push({ type: 'prepare_request' })
      if (current.cache_assembly_final_control_tail_changed) causes.push({ type: 'control_tail_rewritten' })
      if (causes.length) changes.push({ runId, fromTurn: previous.llm_turn, toTurn: current.llm_turn, causes })
    }
  }
  return changes
}
