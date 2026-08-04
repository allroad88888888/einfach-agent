#!/usr/bin/env node
// 读桌面 trace SQLite,输出 F1/F2/F6 验收指标与前缀稳定性(口径见 docs/context-cache-followups.md)。
// 用法:node scripts/cache-investigation/report.js [--db <path>] [--since <ISO 时间>] [--run <runId>]
// 默认复制 db+wal+shm 到临时目录后只读打开,不碰正在运行的桌面应用。

import { copyFileSync, existsSync, mkdtempSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, basename } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  dedupEpochInvalidations,
  epochCauseCounts,
  f1PerRun,
  f6ToolSetSteps,
  weightedHitRate,
  prefixStability,
  requestAssemblyChanges,
} from './lib.js'

function parseArgs(argv) {
  const args = { db: join(homedir(), 'Library/Application Support/com.webagent.app/web-agent.db') }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--db') args.db = argv[++i]
    else if (argv[i] === '--since') args.since = Date.parse(argv[++i])
    else if (argv[i] === '--run') args.run = argv[++i]
    else if (argv[i] === '--help') args.help = true
  }
  if (args.since !== undefined && Number.isNaN(args.since)) throw new Error('--since 需要可解析的时间,例如 2026-08-04T00:00:00+08:00')
  return args
}

function snapshotDb(dbPath) {
  if (!existsSync(dbPath)) throw new Error(`找不到数据库:${dbPath}`)
  const dir = mkdtempSync(join(tmpdir(), 'cache-report-'))
  const copy = join(dir, basename(dbPath))
  copyFileSync(dbPath, copy)
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(dbPath + suffix)) copyFileSync(dbPath + suffix, copy + suffix)
  }
  return copy
}

function query(dbCopy, sql) {
  const proc = spawnSync('sqlite3', ['-json', dbCopy, sql], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 })
  if (proc.status !== 0) throw new Error(`sqlite3 失败:${proc.stderr}`)
  return proc.stdout.trim() ? JSON.parse(proc.stdout) : []
}

function where(args, timeColumn) {
  const clauses = []
  if (args.since !== undefined) clauses.push(`${timeColumn} >= ${args.since}`)
  if (args.run) clauses.push(`run_id = '${args.run.replace(/'/g, "''")}'`)
  return clauses.length ? `AND ${clauses.join(' AND ')}` : ''
}

function loadRows(dbCopy, args) {
  const snapshots = query(dbCopy, `
    SELECT run_id,
           json_extract(attrs,'$.cache_lane_scope_fingerprint') AS cache_lane_scope_fingerprint,
           json_extract(attrs,'$.cache_epoch') AS cache_epoch,
           json_extract(attrs,'$.cache_epoch_reason') AS cache_epoch_reason,
           json_extract(attrs,'$.cache_epoch_causes') AS cache_epoch_causes,
           json_extract(attrs,'$.llm_turn') AS llm_turn,
           json_extract(attrs,'$.tool_set_fingerprint') AS tool_set_fingerprint,
           json_extract(attrs,'$.tools_count') AS tools_count,
           json_extract(attrs,'$.cache_projection_transition') AS cache_projection_transition,
           json_extract(attrs,'$.cache_projection_common_prefix_items') AS cache_projection_common_prefix_items,
           json_extract(attrs,'$.cache_projection_fact_common_prefix_items') AS cache_projection_fact_common_prefix_items,
           json_extract(attrs,'$.cache_projection_first_changed_item_index') AS cache_projection_first_changed_item_index,
           json_extract(attrs,'$.cache_projection_previous_item_role') AS cache_projection_previous_item_role,
           json_extract(attrs,'$.cache_projection_current_item_role') AS cache_projection_current_item_role,
           json_extract(attrs,'$.cache_projection_previous_item_chars') AS cache_projection_previous_item_chars,
           json_extract(attrs,'$.cache_projection_current_item_chars') AS cache_projection_current_item_chars,
           json_extract(attrs,'$.cache_projection_dynamic_controls_changed') AS cache_projection_dynamic_controls_changed,
           json_extract(attrs,'$.cache_assembly_raw_fingerprint') AS cache_assembly_raw_fingerprint,
           json_extract(attrs,'$.cache_assembly_stable_prefix_fingerprint') AS cache_assembly_stable_prefix_fingerprint,
           json_extract(attrs,'$.cache_assembly_control_plan_snapshot_fingerprint') AS cache_assembly_control_plan_snapshot_fingerprint,
           json_extract(attrs,'$.cache_assembly_control_plan_definition_fingerprint') AS cache_assembly_control_plan_definition_fingerprint,
           json_extract(attrs,'$.cache_assembly_control_plan_state_fingerprint') AS cache_assembly_control_plan_state_fingerprint,
           json_extract(attrs,'$.cache_assembly_control_plan_continuation_fingerprint') AS cache_assembly_control_plan_continuation_fingerprint,
           json_extract(attrs,'$.cache_assembly_control_tool_failure_notice_fingerprint') AS cache_assembly_control_tool_failure_notice_fingerprint,
           json_extract(attrs,'$.cache_assembly_control_unknown_fingerprint') AS cache_assembly_control_unknown_fingerprint,
           json_extract(attrs,'$.cache_assembly_tool_names') AS cache_assembly_tool_names,
           json_extract(attrs,'$.cache_assembly_tools_fingerprint') AS cache_assembly_tools_fingerprint,
           json_extract(attrs,'$.cache_assembly_transform_changed') AS cache_assembly_transform_changed,
           json_extract(attrs,'$.cache_assembly_prepare_changed') AS cache_assembly_prepare_changed,
           json_extract(attrs,'$.cache_assembly_final_control_tail_changed') AS cache_assembly_final_control_tail_changed
    FROM trace_events WHERE name='llm.context_snapshot' ${where(args, 'timestamp')}`)
  const events = query(dbCopy, `
    SELECT run_id, name FROM trace_events
    WHERE name IN ('llm.context_compacted','llm.context_projection_extended','llm.context_projection_reused')
      ${where(args, 'timestamp')}`)
  const schemaEvents = query(dbCopy, `
    SELECT name, COUNT(*) AS count FROM trace_events
    WHERE name IN ('tool.schema_autoloaded','tool.schema_requested','tool.schema_not_loaded')
      ${where(args, 'timestamp')} GROUP BY name`)
  const chatSpans = query(dbCopy, `
    SELECT run_id,
           json_extract(attrs,'$.llm_turn') AS llm_turn,
           json_extract(attrs,'$.cache_hit_tk') AS cache_hit_tk,
           json_extract(attrs,'$.cache_miss_tk') AS cache_miss_tk,
           json_extract(attrs,'$.requestPreview') AS requestPreview
    FROM trace_spans WHERE name='llm.chat' AND status='ok' ${where(args, 'started_at')}`)
  const lastEvent = query(dbCopy, 'SELECT MAX(timestamp) AS ts FROM trace_events')[0]?.ts
  return { snapshots, events, schemaEvents, chatSpans, lastEvent }
}

function printReport(rows) {
  const { snapshots, events, schemaEvents, chatSpans, lastEvent } = rows
  console.log(`最后一条 trace 事件:${lastEvent ? new Date(lastEvent).toLocaleString('zh-CN', { hour12: false }) : '无数据'}`)
  console.log(`样本:context_snapshot ${snapshots.length} 条,ok 状态 llm.chat ${chatSpans.length} 条\n`)

  console.log('== F1 · 压缩投影复用 ==')
  const perRun = f1PerRun(events)
  if (!perRun.length) console.log('(区间内没有压缩相关事件——需要越过 20 万 token 软上限的长会话才测得到)')
  for (const entry of perRun) {
    console.log(`run ${entry.runId.slice(0, 8)}…  压缩 ${entry.compacted} / 延伸 ${entry.extended} / 复用 ${entry.reused}  每次重压摊 ${entry.reusePerRebuild.toFixed(1)} 轮复用`)
  }
  const invalidations = dedupEpochInvalidations(snapshots)
  console.log(`按 (scope, epoch) 去重的真实失效:${JSON.stringify(invalidations)}`)
  const causeCounts = epochCauseCounts(snapshots)
  if (Object.keys(causeCounts).length) {
    console.log(`开新 epoch 轮的底层因子(非互斥,按 scope+epoch 去重;profile_changed 在此展开为具体因子):${JSON.stringify(causeCounts)}`)
  }
  console.log('  验收③:compaction_projection_changed 应接近「每 run 首压一次」;')
  console.log('  F2:history_inserted_before_dynamic_tail 应为 0(tracker 2026-08-04 起纯顶位不再计失效)\n')

  console.log('== F6 · 工具集增长步数 ==')
  const f6 = f6ToolSetSteps(snapshots)
  console.log(`步数均值 ${f6.meanSteps.toFixed(2)}(基线 1.94)  最大 ${f6.maxSteps}(基线 9)`)
  for (const entry of f6.perRun.slice(0, 5)) {
    console.log(`run ${entry.runId.slice(0, 8)}…  步数 ${entry.steps}  最终工具数 ${entry.maxTools}`)
  }
  console.log(`schema 事件:${JSON.stringify(Object.fromEntries(schemaEvents.map((row) => [row.name, row.count])))}`)
  console.log('  验收①:tool.schema_not_loaded 冷启动应归零\n')

  console.log('== 供应商加权命中率(F1 验收④,与 DeepSeek 控制台对账) ==')
  const rate = weightedHitRate(chatSpans)
  console.log(`hit ${rate.hitTokens} tk / miss ${rate.missTokens} tk  加权命中率 ${rate.hitRate === undefined ? '无数据' : `${(rate.hitRate * 100).toFixed(1)}%`}(历史基线 63.9%)\n`)

  console.log('== 我们侧前缀稳定性(preview 窗口内相邻轮逐字节对比) ==')
  const rebuildsByRun = new Map()
  for (const entry of perRun) rebuildsByRun.set(entry.runId, entry.compacted + entry.extended)
  for (const entry of prefixStability(chatSpans)) {
    if (entry.turns < 2) continue
    const rebuilds = rebuildsByRun.get(entry.runId) ?? 0
    const verdict = entry.stable ? '稳定' : `分歧 ${entry.divergences.length} 处(该 run 有 ${rebuilds} 次重压/延伸,压缩轮的分歧属预期)`
    console.log(`run ${entry.runId.slice(0, 8)}…  ${entry.turns} 轮  窗口 ${entry.windowChars} 字符  ${verdict}`)
    for (const diff of entry.divergences) {
      console.log(`    轮 ${diff.fromTurn} → ${diff.toTurn} 在第 ${diff.atChar} 字符处分歧`)
    }
  }
  console.log('  窗口内稳定 + 供应商仍报低命中 ⇒ 供应商侧因素(路由/建缓存延迟),不是本地请求不稳定')

  console.log('\n== 请求组装来源归因（内容脱敏） ==')
  const assemblyChanges = requestAssemblyChanges(snapshots)
  if (!assemblyChanges.length) {
    console.log('(没有新组装诊断字段：请用包含本次日志的桌面端至少完成两轮请求)')
  }
  for (const entry of assemblyChanges) {
    const causes = entry.causes.map((cause) => {
      if (cause.type === 'dynamic_control') return `动态控制:${cause.source}`
      if (cause.type === 'tool_membership') return `工具集合:${cause.from || '无'}→${cause.to || '无'}`
      if (cause.type === 'tool_schema') return '工具 schema 改写'
      if (cause.type === 'stable_prefix') return '稳定前缀改写'
      if (cause.type === 'transform_context') return 'transformContext 改写'
      if (cause.type === 'prepare_request') return 'prepareRequest 改写'
      return '动态控制尾巴被钩子改写'
    }).join('；')
    console.log(`run ${entry.runId.slice(0, 8)}…  轮 ${entry.fromTurn} → ${entry.toTurn}  ${causes}`)
  }

  console.log('\n== 请求投影变更诊断（内容脱敏） ==')
  const transitions = snapshots.filter((row) => row.cache_projection_transition && row.cache_projection_transition !== 'initial')
  if (!transitions.length) {
    console.log('(没有新诊断字段：请使用包含本次日志的桌面端完成一轮测试)')
    return
  }
  for (const row of transitions) {
    const point = row.cache_projection_first_changed_item_index
    const roles = row.cache_projection_previous_item_role || row.cache_projection_current_item_role
      ? `${row.cache_projection_previous_item_role ?? '结束'}→${row.cache_projection_current_item_role ?? '结束'}`
      : '无变化'
    const chars = row.cache_projection_previous_item_chars ?? row.cache_projection_current_item_chars
      ? ` 字符 ${row.cache_projection_previous_item_chars ?? 0}→${row.cache_projection_current_item_chars ?? 0}`
      : ''
    console.log(`run ${row.run_id.slice(0, 8)}…  轮 ${row.llm_turn}  ${row.cache_projection_transition}  共同前缀 ${row.cache_projection_common_prefix_items ?? 0}（事实 ${row.cache_projection_fact_common_prefix_items ?? 0}） 首差项 ${point ?? '无'} ${roles}${chars}${row.cache_projection_dynamic_controls_changed ? ' 动态控制已变' : ''}`)
  }
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  console.log('用法:node scripts/cache-investigation/report.js [--db <path>] [--since <ISO 时间>] [--run <runId>]')
} else {
  printReport(loadRows(snapshotDb(args.db), args))
}
