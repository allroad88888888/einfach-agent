#!/usr/bin/env node

import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { compactSubagentIndex, SUBAGENT_INDEX_NAMES } from './subagent-index-lib.js'
import { acquireArchivePathLocks } from './subagent-archive-lock.js'

function parseArgs(argv) {
  const parsed = { basePath: process.cwd(), write: false }
  const args = argv.slice(2)
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '-h' || arg === '--help') parsed.help = true
    else if (arg === '--write') parsed.write = true
    else if (arg === '--base' || arg === '-b') {
      const value = args[index + 1]
      if (!value?.trim()) throw new Error('--base requires a non-empty path')
      parsed.basePath = value.trim()
      index += 1
    } else throw new Error(`unknown option: ${arg}`)
  }
  return parsed
}

function helpText() {
  return [
    'subagent-index-compact',
    '',
    'Deduplicate .webAgent-archive/index/*.jsonl by logical key, keeping the latest record.',
    'The append-only conversations/**/events.jsonl files are never read or changed.',
    '',
    'Usage:',
    '  node scripts/subagent-index-compact.js [--base <workspace>] [--write]',
    '',
    'Options:',
    '  --base, -b  workspace containing .webAgent-archive (default: process.cwd())',
    '  --write     atomically replace indexes; without it, only report the plan',
    '  --help      show help',
  ].join('\n') + '\n'
}

async function fileExists(path) {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function atomicWrite(path, text) {
  const temporaryPath = `${path}.compact-${process.pid}-${Date.now()}.tmp`
  await writeFile(temporaryPath, text, 'utf8')
  try {
    await rename(temporaryPath, path)
  } finally {
    await unlink(temporaryPath).catch(() => undefined)
  }
}

async function run() {
  const options = parseArgs(process.argv)
  if (options.help) {
    process.stdout.write(helpText())
    return
  }

  const basePath = isAbsolute(options.basePath) ? options.basePath : resolve(process.cwd(), options.basePath)
  const indexRoot = resolve(basePath, '.webAgent-archive', 'index')
  const indexPaths = SUBAGENT_INDEX_NAMES.map((name) => resolve(indexRoot, `${name}.jsonl`))
  const existingIndexPaths = []
  for (const path of indexPaths) {
    if (await fileExists(path)) existingIndexPaths.push(path)
  }
  const releaseLocks = options.write
    ? await acquireArchivePathLocks(existingIndexPaths)
    : async () => undefined
  const plans = []

  try {
    // Parse every existing index before writing any of them. A malformed record therefore
    // stops the operation without leaving a partially compacted index set.
    for (const name of SUBAGENT_INDEX_NAMES) {
      const path = resolve(indexRoot, `${name}.jsonl`)
      if (!(await fileExists(path))) {
        plans.push({ name, path, skipped: true })
        continue
      }
      const result = compactSubagentIndex(name, await readFile(path, 'utf8'))
      plans.push({ name, path, ...result })
    }

    if (options.write) {
      for (const plan of plans) {
        if (!plan.skipped && plan.removedRecords > 0) await atomicWrite(plan.path, plan.text)
      }
    }

    for (const plan of plans) {
      if (plan.skipped) {
        process.stdout.write(`${plan.name}: skipped (missing)\n`)
        continue
      }
      const action = options.write && plan.removedRecords > 0 ? 'compacted' : options.write ? 'unchanged' : 'dry-run'
      process.stdout.write(
        `${plan.name}: ${action}; records=${plan.records}, unique=${plan.uniqueRecords}, removable=${plan.removedRecords}\n`,
      )
    }
  } finally {
    await releaseLocks()
  }
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.stderr.write('run with --help for usage.\n')
  process.exitCode = 1
})
