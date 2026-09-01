#!/usr/bin/env node

import { lstat, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

function helpText() {
  return `agent-rollout-rebuild

Rebuild the disposable rollout SQLite projection from append-only JSONL sources.

Usage:
  pnpm agent-rollout:rebuild -- [--database-path <absolute-path>] [--rollout-root <absolute-path>] [--write]

Options:
  --database-path <path>  SQLite database to inspect or rebuild (default: app-data/web-agent.db)
  --rollout-root <path>   app-data/rollouts directory to scan (default: app-data/rollouts)
  --write                 drop only the defined rollout projection tables, then rebuild them from JSONL
  --help, -h              show this help

Without --write this command is a dry-run and changes neither SQLite nor JSONL.
JSONL is never modified by this command.
`
}

function parseArgs(argv) {
  const result = { write: false }
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') continue
    if (arg === '--write') result.write = true
    else if (arg === '--help' || arg === '-h') result.help = true
    else if (arg === '--database-path' || arg === '--rollout-root') {
      const value = argv[++index]
      if (!value?.trim()) throw new Error(`${arg} requires a non-empty path`)
      result[arg === '--database-path' ? 'databasePath' : 'rolloutRoot'] = value.trim()
    } else throw new Error(`unknown option: ${arg}`)
  }
  return result
}

function containedBy(path, parent) {
  const segment = relative(parent, path)
  return segment === '' || (!segment.startsWith('..') && !isAbsolute(segment))
}

async function canonicalize(path) {
  const absolute = resolve(path)
  let existing = absolute
  const missing = []
  while (true) {
    try {
      await lstat(existing)
      return join(await realpath(existing), ...missing.reverse())
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      const parent = dirname(existing)
      if (parent === existing) throw error
      missing.push(basename(existing))
      existing = parent
    }
  }
}

async function protectedRoots() {
  return Promise.all(['/', homedir(), process.cwd()].map(canonicalize))
}

async function pathsFor(options) {
  const { resolveAppDataDirectory } = await import('../packages/host-node/src/index.ts')
  const defaultAppData = resolveAppDataDirectory({ homeDirectory: homedir(), platform: process.platform, env: process.env })
  const rawRoot = options.rolloutRoot ?? join(defaultAppData, 'rollouts')
  const rawDatabase = options.databasePath ?? join(defaultAppData, 'web-agent.db')
  if (!isAbsolute(rawRoot) || !isAbsolute(rawDatabase)) throw new Error('override paths must be absolute')
  const [rolloutRoot, databasePath, protectedPaths] = await Promise.all([canonicalize(rawRoot), canonicalize(rawDatabase), protectedRoots()])
  if (protectedPaths.some((path) => path === rolloutRoot || path === databasePath)) throw new Error('refuses broad path or its alias')
  if (basename(resolve(rawRoot)) !== 'rollouts') throw new Error('--rollout-root must name a rollouts directory')
  if (containedBy(databasePath, rolloutRoot) || containedBy(rolloutRoot, databasePath)) {
    throw new Error('--database-path must be disjoint from --rollout-root')
  }
  return { appData: dirname(rolloutRoot), rolloutRoot, databasePath }
}

export async function rebuild(options) {
  const paths = await pathsFor(options)
  const host = await import('../packages/host-node/src/index.ts')
  const sources = await host.discoverCanonicalRolloutSources(paths.appData)
  const preflight = await host.preflightRolloutSources(paths.appData, sources)
  const summary = { ...paths, ...preflight }
  if (!options.write) return { ...summary, action: 'dry-run' }

  const executor = await host.createNodeSqlExecutorLoader({ databasePath: paths.databasePath }, 'persistence')()
  try {
    await host.dropRolloutProjectionSchema(executor)
    const result = await host.createNodeAgentRolloutDriver({ appDataDirectory: paths.appData, executor }).reconcile()
    const failed = result.histories.find((history) => history.warning)
    if (failed?.warning) throw new Error(`rebuild failed for ${failed.historyId}: ${failed.warning.message}`)
    return { ...summary, action: 'rebuilt', records: result.histories.reduce((total, history) => total + history.recordsApplied, 0) }
  } finally { await host.closeSqliteConnections() }
}

async function main() {
  const options = parseArgs(process.argv)
  if (options.help) return process.stdout.write(helpText())
  const result = await rebuild(options)
  process.stdout.write(`${result.action}: app-data=${result.appData}; files=${result.files}; bytes=${result.bytes}`
    + (result.records === undefined ? '\n' : `; records=${result.records}\n`))
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
