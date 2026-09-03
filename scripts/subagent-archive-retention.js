#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { appendFile, copyFile, lstat, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { acquireArchivePathLocks } from './subagent-archive-lock.js'
import { resolveArchiveRunPath, safeArchiveSegment } from './subagent-archive-paths.js'
import {
  createArchiveRetentionManifest,
  isDerivedArchivePath,
  planArchiveRetention,
  validateArchiveRetentionManifest,
} from './subagent-archive-retention-lib.js'

function parseArgs(argv) {
  const options = { action: 'list', basePath: process.cwd(), write: false }
  let explicitAction
  const choose = (action) => {
    if (explicitAction) throw new Error('choose exactly one --list, --prune, --export, or --restore action')
    explicitAction = action
    options.action = action
  }
  const value = (args, index, option) => {
    const next = args[index + 1]
    if (!next?.trim()) throw new Error(`${option} requires a non-empty value`)
    return next.trim()
  }
  const args = argv.slice(2)
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '-h' || arg === '--help') options.help = true
    else if (arg === '--write') options.write = true
    else if (arg === '--list') choose('list')
    else if (arg === '--prune') choose('prune')
    else if (arg === '--restore') {
      choose('restore')
      options.restorePath = value(args, index, arg)
      index += 1
    } else if (arg === '--base' || arg === '-b') {
      options.basePath = value(args, index, arg)
      index += 1
    } else if (arg === '--export') {
      options.exportPath = value(args, index, arg)
      index += 1
    } else if (arg === '--conversation' || arg === '-c') {
      options.conversationId = value(args, index, arg)
      index += 1
    } else if (arg === '--run' || arg === '-r') {
      options.runId = value(args, index, arg)
      index += 1
    } else if (arg === '--max-bytes') {
      const raw = value(args, index, arg)
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error('--max-bytes must be a safe integer')
      options.maxBytes = Number(raw)
      index += 1
    } else throw new Error(`unknown option: ${arg}`)
  }
  if (!options.help && !explicitAction && options.exportPath) options.action = 'export'
  if (options.action === 'list' && options.write) throw new Error('--write is only valid with a mutation')
  if (options.action === 'list' && (options.exportPath || options.restorePath || options.conversationId || options.runId)) {
    throw new Error('--list cannot be combined with export, restore, or run selection')
  }
  if (options.action === 'prune' && (!options.write || options.maxBytes === undefined || !options.exportPath)) {
    throw new Error('--prune requires --max-bytes, --export, and --write')
  }
  if (options.action === 'export' && (!options.write || !options.exportPath || !options.conversationId || !options.runId)) {
    throw new Error('--export requires --conversation, --run, and --write')
  }
  if (options.action === 'restore' && (!options.write || !options.restorePath)) throw new Error('--restore requires --write')
  return options
}

function helpText() {
  return [
    'subagent-archive-retention', '',
    'Plan capacity cleanup, export completed runs, and restore only exported derived artifacts.',
    'events.jsonl and run.json are never removed or overwritten.', '',
    'Usage:',
    '  node scripts/subagent-archive-retention.js [--base <workspace>] [--max-bytes <n>]',
    '  node scripts/subagent-archive-retention.js --prune --max-bytes <n> --export <directory> --write [--base <workspace>]',
    '  node scripts/subagent-archive-retention.js --export <directory> --conversation <id> --run <id> --write [--base <workspace>]',
    '  node scripts/subagent-archive-retention.js --restore <directory> --write [--base <workspace>]', '',
    'The prune export directory must be outside .webAgent-archive and must not already exist.',
  ].join('\n') + '\n'
}

function isInside(parent, child) {
  const diff = relative(parent, child)
  return diff === '' || (!diff.startsWith('..') && !isAbsolute(diff))
}

async function pathType(path) {
  return lstat(path).catch((error) => error?.code === 'ENOENT' ? undefined : Promise.reject(error))
}

async function collectFiles(root, prefix = '') {
  const entries = await readdir(root, { withFileTypes: true }).catch((error) => error?.code === 'ENOENT' ? [] : Promise.reject(error))
  const files = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const nextPath = resolve(root, entry.name)
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) files.push(...await collectFiles(nextPath, relativePath))
    else if (entry.isFile()) files.push({ path: nextPath, relativePath, bytes: (await stat(nextPath)).size })
    else throw new Error(`refusing non-regular archive entry: ${nextPath}`)
  }
  return files
}

function parseRunRecord(text, path) {
  try {
    const record = JSON.parse(text)
    if (!record || typeof record !== 'object' || Array.isArray(record) || typeof record.status !== 'string') {
      throw new Error('missing status')
    }
    return record
  } catch (error) {
    throw new Error(`invalid run record ${path}: ${error.message}`)
  }
}

async function loadRun(archiveRoot, conversationId, runId) {
  const runPath = resolveArchiveRunPath(archiveRoot, conversationId, runId)
  if (!(await pathType(runPath))?.isDirectory()) throw new Error(`run archive not found: ${conversationId}/${runId}`)
  const files = await collectFiles(runPath)
  const runFile = files.find((file) => file.relativePath === 'run.json')
  if (!runFile) throw new Error(`run archive has no run.json: ${conversationId}/${runId}`)
  const record = parseRunRecord(await readFile(runFile.path, 'utf8'), runFile.path)
  const startedAt = Date.parse(record.startedAt)
  return {
    conversationId: safeArchiveSegment(conversationId), runId: safeArchiveSegment(runId), runPath, record,
    sortAt: Number.isFinite(startedAt) ? startedAt : (await stat(runPath)).mtimeMs,
    files, reclaimableBytes: files.filter((file) => isDerivedArchivePath(file.relativePath)).reduce((sum, file) => sum + file.bytes, 0),
  }
}

async function loadRuns(archiveRoot) {
  const conversations = await readdir(resolve(archiveRoot, 'conversations'), { withFileTypes: true })
    .catch((error) => error?.code === 'ENOENT' ? [] : Promise.reject(error))
  const runs = []
  for (const conversation of conversations.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const runRoot = resolve(archiveRoot, 'conversations', conversation.name, 'runs')
    const entries = await readdir(runRoot, { withFileTypes: true }).catch((error) => error?.code === 'ENOENT' ? [] : Promise.reject(error))
    for (const run of entries.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      runs.push(await loadRun(archiveRoot, conversation.name, run.name))
    }
  }
  return runs
}

async function archiveBytes(archiveRoot) {
  return (await collectFiles(archiveRoot)).reduce((sum, file) => sum + file.bytes, 0)
}

function assertCompleted(runs) {
  for (const run of runs) {
    if (run.record.status !== 'delegated') throw new Error(`run is not complete and cannot be governed: ${run.conversationId}/${run.runId}`)
  }
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

async function manifestRun(run, files) {
  return {
    conversationId: run.conversationId,
    runId: run.runId,
    files: await Promise.all(files.map(async (file) => ({ path: file.relativePath, bytes: file.bytes, sha256: await sha256(file.path) }))),
  }
}

async function createExport({ archiveRoot, exportPath, kind, runs, archiveBytesBefore, projectedArchiveBytesAfter, derivedOnly }) {
  if (isInside(archiveRoot, exportPath)) throw new Error('export directory must be outside .webAgent-archive')
  if (await pathType(exportPath)) throw new Error(`export directory already exists: ${exportPath}`)
  const selectedRuns = await Promise.all(runs.map((run) => manifestRun(run, derivedOnly ? run.files.filter((file) => isDerivedArchivePath(file.relativePath)) : run.files)))
  const manifest = createArchiveRetentionManifest({ kind, createdAt: new Date().toISOString(), archiveBytesBefore, projectedArchiveBytesAfter, selectedRuns })
  const temporaryPath = `${exportPath}.partial-${process.pid}-${Date.now()}`
  await mkdir(temporaryPath, { recursive: true })
  for (const run of manifest.selectedRuns) {
    for (const file of run.files) {
      const source = resolve(archiveRoot, 'conversations', run.conversationId, 'runs', run.runId, file.path)
      const target = resolve(temporaryPath, 'runs', run.conversationId, run.runId, file.path)
      if (!isInside(temporaryPath, target) || !(await pathType(source))?.isFile()) throw new Error(`export source changed: ${source}`)
      await mkdir(dirname(target), { recursive: true })
      await copyFile(source, target)
      if (await sha256(target) !== file.sha256) throw new Error(`export checksum mismatch: ${file.path}`)
    }
  }
  await writeFile(resolve(temporaryPath, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  await rename(temporaryPath, exportPath)
  return manifest
}

async function appendAudit(archiveRoot, record) {
  const path = resolve(archiveRoot, 'governance', 'retention-actions.jsonl')
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, `${JSON.stringify({ type: 'archive_retention', at: new Date().toISOString(), ...record })}\n`, 'utf8')
  return path
}

async function ensureGovernanceRoot(archiveRoot) {
  await mkdir(resolve(archiveRoot, 'governance'), { recursive: true })
}

function actionSummary(runs) {
  return runs.map((run) => ({ conversationId: run.conversationId, runId: run.runId }))
}

function printPlan(plan) {
  process.stdout.write(`archive_bytes=${plan.archiveBytes}\n`)
  if (plan.maxBytes === undefined) return
  process.stdout.write(`threshold=${plan.maxBytes}; projected=${plan.projectedArchiveBytes}; reclaimable=${plan.reclaimableBytes}; reachable=${plan.thresholdReached}\n`)
  for (const run of plan.selectedRuns) process.stdout.write(`select ${run.conversationId}/${run.runId}: ${run.reclaimableBytes} bytes\n`)
}

async function withLocks(paths, operation) {
  const release = await acquireArchivePathLocks(paths)
  try { return await operation() } finally { await release() }
}

async function prune(archiveRoot, options) {
  const before = await archiveBytes(archiveRoot)
  const plan = planArchiveRetention({ archiveBytes: before, maxBytes: options.maxBytes, runs: await loadRuns(archiveRoot) })
  if (plan.selectedRuns.length === 0) throw new Error('archive already satisfies the threshold; no prune is needed')
  if (!plan.thresholdReached) throw new Error('threshold cannot be met without removing preserved events.jsonl or run.json')
  assertCompleted(plan.selectedRuns)
  await ensureGovernanceRoot(archiveRoot)
  const auditPath = resolve(archiveRoot, 'governance', 'retention-actions.jsonl')
  const locked = [...plan.selectedRuns.flatMap((run) => [resolve(run.runPath, 'run.json'), ...run.files.filter((file) => isDerivedArchivePath(file.relativePath)).map((file) => file.path)]), auditPath]
  await withLocks(locked, async () => {
    const manifest = await createExport({ archiveRoot, exportPath: options.exportPath, kind: 'subagent_retention_prune', runs: plan.selectedRuns, archiveBytesBefore: before, projectedArchiveBytesAfter: plan.projectedArchiveBytes, derivedOnly: true })
    await appendAudit(archiveRoot, { action: 'prune', state: 'exported', exportPath: options.exportPath, runs: actionSummary(plan.selectedRuns) })
    for (const run of plan.selectedRuns) for (const file of run.files.filter((item) => isDerivedArchivePath(item.relativePath))) await unlink(file.path)
    await appendAudit(archiveRoot, { action: 'prune', state: 'completed', exportPath: options.exportPath, runs: actionSummary(manifest.selectedRuns), reclaimedBytes: plan.reclaimableBytes })
  })
  process.stdout.write(`pruned=${plan.selectedRuns.length}; reclaimed=${plan.reclaimableBytes}; events_preserved=true; export=${options.exportPath}\n`)
}

async function exportRun(archiveRoot, options) {
  const run = await loadRun(archiveRoot, options.conversationId, options.runId)
  assertCompleted([run])
  const before = await archiveBytes(archiveRoot)
  await ensureGovernanceRoot(archiveRoot)
  const auditPath = resolve(archiveRoot, 'governance', 'retention-actions.jsonl')
  await withLocks([auditPath, ...run.files.map((file) => file.path)], async () => {
    const manifest = await createExport({ archiveRoot, exportPath: options.exportPath, kind: 'subagent_archive_export', runs: [run], archiveBytesBefore: before, projectedArchiveBytesAfter: before, derivedOnly: false })
    await appendAudit(archiveRoot, { action: 'export', state: 'completed', exportPath: options.exportPath, runs: actionSummary(manifest.selectedRuns) })
  })
  process.stdout.write(`exported=${run.conversationId}/${run.runId}; events_preserved=true; export=${options.exportPath}\n`)
}

async function restore(archiveRoot, options) {
  if (isInside(archiveRoot, options.restorePath)) throw new Error('restore directory must be outside .webAgent-archive')
  const manifestPath = resolve(options.restorePath, 'manifest.json')
  const manifest = validateArchiveRetentionManifest(JSON.parse(await readFile(manifestPath, 'utf8')))
  if (manifest.kind !== 'subagent_retention_prune') throw new Error('only a retention prune export can be restored')
  const runs = await Promise.all(manifest.selectedRuns.map((entry) => loadRun(archiveRoot, entry.conversationId, entry.runId)))
  assertCompleted(runs)
  const targets = manifest.selectedRuns.flatMap((run) => run.files.map((file) => resolve(archiveRoot, 'conversations', run.conversationId, 'runs', run.runId, file.path)))
  if (await Promise.all(targets.map(pathType)).then((types) => types.some(Boolean))) throw new Error('restore refused because a derived target already exists')
  await ensureGovernanceRoot(archiveRoot)
  const auditPath = resolve(archiveRoot, 'governance', 'retention-actions.jsonl')
  await withLocks([auditPath, ...runs.map((run) => resolve(run.runPath, 'run.json'))], async () => {
    await appendAudit(archiveRoot, { action: 'restore', state: 'started', exportPath: options.restorePath, runs: actionSummary(manifest.selectedRuns) })
    for (const run of manifest.selectedRuns) for (const file of run.files) {
      const source = resolve(options.restorePath, 'runs', run.conversationId, run.runId, file.path)
      const target = resolve(archiveRoot, 'conversations', run.conversationId, 'runs', run.runId, file.path)
      if (!(await pathType(source))?.isFile() || await sha256(source) !== file.sha256) throw new Error(`restore checksum mismatch: ${file.path}`)
      await mkdir(dirname(target), { recursive: true })
      await copyFile(source, target)
    }
    await appendAudit(archiveRoot, { action: 'restore', state: 'completed', exportPath: options.restorePath, runs: actionSummary(manifest.selectedRuns) })
  })
  process.stdout.write(`restored=${manifest.selectedRuns.length}; events_preserved=true; export=${options.restorePath}\n`)
}

async function run() {
  const options = parseArgs(process.argv)
  if (options.help) return process.stdout.write(helpText())
  const basePath = isAbsolute(options.basePath) ? options.basePath : resolve(process.cwd(), options.basePath)
  const archiveRoot = resolve(basePath, '.webAgent-archive')
  options.exportPath = options.exportPath ? resolve(basePath, options.exportPath) : undefined
  options.restorePath = options.restorePath ? resolve(basePath, options.restorePath) : undefined
  if (options.action === 'prune') return prune(archiveRoot, options)
  if (options.action === 'export') return exportRun(archiveRoot, options)
  if (options.action === 'restore') return restore(archiveRoot, options)
  const before = await archiveBytes(archiveRoot)
  const plan = options.maxBytes === undefined ? { archiveBytes: before } : planArchiveRetention({ archiveBytes: before, maxBytes: options.maxBytes, runs: await loadRuns(archiveRoot) })
  printPlan(plan)
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.stderr.write('run with --help for usage.\n')
  process.exitCode = 1
})
