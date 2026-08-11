#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { parseSubagentEvents, parseSubagentTreeSnapshot, replaySubagentArchive, formatReplayReport } from './subagent-replay-lib.js'

function safeSegment(value) {
  const safe = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 96)
  return safe || 'unknown'
}

function parseArgs(argv) {
  const args = argv.slice(2)
  const parsed = {
    format: 'md',
    basePath: process.cwd(),
    includeTree: true,
    json: false,
  }

  const asString = (value) => {
    if (value === undefined || value.trim() === '') {
      throw new Error('option value cannot be empty')
    }
    return value.trim()
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    switch (arg) {
      case '-h':
      case '--help':
        parsed.help = true
        break
      case '-c':
      case '--conversation':
        parsed.conversationId = asString(args[index + 1])
        index += 1
        break
      case '-r':
      case '--run':
        parsed.runId = asString(args[index + 1])
        index += 1
        break
      case '--events':
        parsed.eventsPath = asString(args[index + 1])
        index += 1
        break
      case '--tree':
        parsed.treePath = asString(args[index + 1])
        index += 1
        break
      case '--base':
      case '-b':
        parsed.basePath = asString(args[index + 1])
        index += 1
        break
      case '--format':
        parsed.format = asString(args[index + 1])
        index += 1
        break
      case '--jsonl':
        parsed.format = 'json'
        break
      case '--json':
        parsed.json = true
        break
      case '--out':
        parsed.outPath = asString(args[index + 1])
        index += 1
        break
      case '--no-tree':
        parsed.includeTree = false
        break
      default:
        throw new Error(`unknown option: ${arg}`)
    }
  }

  if (parsed.format !== 'md' && parsed.format !== 'text' && parsed.format !== 'json') {
    throw new Error(`unsupported format: ${parsed.format}`)
  }
  if (parsed.help) return parsed
  if (parsed.eventsPath === undefined && (!parsed.conversationId || !parsed.runId)) {
    throw new Error('must provide --conversation/--run or --events')
  }

  return parsed
}

function printHelp() {
  const lines = [
    'subagent-replay-report',
    '',
    'Usage:',
    '  node scripts/subagent-replay-report.js --conversation <conversationId> --run <runId> [options]',
    '  node scripts/subagent-replay-report.js --events <events.jsonl> [options]',
    '',
    'Options:',
    '  --conversation, -c   conversationId',
    '  --run, -r            runId',
    '  --events              path to events.jsonl (optional, overrides --conversation/--run)',
    '  --tree                path to tree.json',
    '  --base                base directory, default process.cwd()',
    '  --format md|text|json  default: md',
    '  --json                alias for --format json',
    '  --jsonl               alias for --format json',
    '  --out                 write output to file',
    '  --no-tree             do not load tree.json',
    '  --help                show help',
    '',
    'Examples:',
    '  node scripts/subagent-replay-report.js -c c1 -r r1',
    '  node scripts/subagent-replay-report.js --events .webAgent-archive/conversations/c1/runs/r1/events.jsonl --json > replay.json',
  ]
  return `${lines.join('\n')}\n`
}

function resolveArchivePaths(opts) {
  const archiveRoot = resolve(
    opts.basePath,
    '.webAgent-archive',
    'conversations',
    safeSegment(opts.conversationId),
    'runs',
    safeSegment(opts.runId),
  )

  return {
    eventsPath: resolve(archiveRoot, 'events.jsonl'),
    treePath: resolve(archiveRoot, 'tree.json'),
  }
}

function resolvePath(value, basePath) {
  return isAbsolute(value) ? value : resolve(basePath, value)
}

function normalizeState(state) {
  return {
    ...state,
    orderedPaths: state.orderedPaths ?? Object.keys(state.nodes).sort(),
  }
}

async function readOptionalText(filePath) {
  try {
    return await readFile(filePath, 'utf8')
  } catch {
    return undefined
  }
}

async function run() {
  const parsed = parseArgs(process.argv)
  if (parsed.help) {
    process.stdout.write(printHelp())
    return
  }

  const archivePaths = parsed.conversationId && parsed.runId ? resolveArchivePaths(parsed) : undefined
  const eventsPath = parsed.eventsPath ?? archivePaths?.eventsPath
  const treePath = parsed.includeTree ? parsed.treePath ?? archivePaths?.treePath : undefined
  if (eventsPath === undefined) throw new Error('must provide --events path or --conversation/--run')
  const resolvedEventsPath = resolvePath(eventsPath, parsed.basePath)
  const resolvedTreePath = treePath ? resolvePath(treePath, parsed.basePath) : undefined
  const eventsText = await readFile(resolvedEventsPath, 'utf8')
  const treeText = resolvedTreePath ? await readOptionalText(resolvedTreePath) : undefined

  const state = normalizeState(replaySubagentArchive({
    eventsText,
    treeText,
  }))

  const text = parsed.json || parsed.format === 'json'
    ? `${JSON.stringify(state, null, 2)}\n`
    : formatReplayReport(state)

  if (parsed.outPath) {
    await writeFile(parsed.outPath, text, 'utf8')
    process.stdout.write(`saved: ${parsed.outPath}\n`)
    return
  }
  if (parsed.format !== 'text') {
    process.stdout.write(text)
    return
  }

  const eventCount = Object.values(state.eventCounts).reduce((sum, value) => sum + value, 0)
  const summaryLines = [
    'Replay Events',
    '',
    `events=${eventCount}, nodes=${state.summary.total}, done=${state.summary.done}, failed=${state.summary.failed}`,
    ...state.orderedPaths.slice(0, 24).map((path) => `${path}: ${state.nodes[path].status}`),
  ]
  process.stdout.write(`${summaryLines.join('\n')}\n`)
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.stderr.write('run with --help for usage.\n')
  process.exitCode = 1
})
