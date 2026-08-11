#!/usr/bin/env node

import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import {
  appendGovernanceRecords,
  assertIndexMatchesFrontmatter,
  candidateSkills,
  parseSkillFrontmatter,
  parseSkillIndex,
  transitionFor,
  updateSkillPromotion,
  validateGovernanceAudit,
} from './subagent-skill-governance-lib.js'
import { acquireArchivePathLocks } from './subagent-archive-lock.js'

function parseArgs(argv) {
  const parsed = { basePath: process.cwd(), action: 'list', json: false, write: false }
  let explicitAction
  const args = argv.slice(2)
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '-h' || arg === '--help') parsed.help = true
    else if (arg === '--list') {
      if (explicitAction) throw new Error('choose exactly one --list, --promote, or --archive action')
      explicitAction = 'list'
      parsed.action = 'list'
    }
    else if (arg === '--json') parsed.json = true
    else if (arg === '--write') parsed.write = true
    else if (arg === '--base' || arg === '-b') {
      const value = args[++index]
      if (!value?.trim()) throw new Error('--base requires a non-empty path')
      parsed.basePath = value.trim()
    } else if (arg === '--promote' || arg === '--archive') {
      if (explicitAction) throw new Error('choose exactly one --list, --promote, or --archive action')
      const value = args[++index]
      if (!value?.trim()) throw new Error(`${arg} requires a skillId`)
      explicitAction = arg.slice(2)
      parsed.action = arg.slice(2)
      parsed.skillId = value.trim()
    } else throw new Error(`unknown option: ${arg}`)
  }
  if (parsed.action === 'list' && parsed.write) throw new Error('--write is only valid with --promote or --archive')
  if (parsed.action !== 'list' && !parsed.write) {
    throw new Error(`--${parsed.action} is a mutation; repeat with --write after reviewing --list`)
  }
  return parsed
}

function helpText() {
  return [
    'subagent-skill-governance',
    '',
    'List candidate skills or explicitly promote/archive one skill.',
    'Listing is the default. Mutations require both an action and --write.',
    '',
    'Usage:',
    '  node scripts/subagent-skill-governance.js [--base <workspace>] [--list] [--json]',
    '  node scripts/subagent-skill-governance.js --promote <skillId> --write [--base <workspace>]',
    '  node scripts/subagent-skill-governance.js --archive <skillId> --write [--base <workspace>]',
    '',
    'Options:',
    '  --base, -b         workspace containing .webAgent-archive (default: process.cwd())',
    '  --list             list candidate skills (default)',
    '  --json             emit list as JSON',
    '  --promote <id>     transition candidate -> promoted',
    '  --archive <id>     transition candidate/promoted -> archived',
    '  --write            required confirmation for a mutation',
    '  --help             show help',
  ].join('\n') + '\n'
}

async function fileExists(path) {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function writeTemporary(path, text) {
  const temporaryPath = `${path}.governance-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`
  const handle = await open(temporaryPath, 'wx')
  try {
    await handle.writeFile(text, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  return temporaryPath
}

async function syncDirectory(path) {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function replaceFile(path, text) {
  const temporaryPath = await writeTemporary(path, text)
  try {
    await rename(temporaryPath, path)
    await syncDirectory(resolve(path, '..'))
  } finally {
    await unlink(temporaryPath).catch(() => undefined)
  }
}

const JOURNAL_VERSION = 1
const JOURNAL_STATES = new Set(['prepared', 'committing', 'committed', 'rolling_back', 'rolled_back'])
const SNAPSHOT_KEYS = ['skill', 'index', 'audit']

function validateJournal(journal) {
  if (!journal || typeof journal !== 'object' || Array.isArray(journal) || journal.version !== JOURNAL_VERSION) {
    throw new Error('invalid governance transaction journal')
  }
  if (typeof journal.transactionId !== 'string' || !journal.transactionId.trim()
    || typeof journal.at !== 'string' || !journal.at.trim()) {
    throw new Error('invalid governance transaction journal identity')
  }
  if (!JOURNAL_STATES.has(journal.state)) throw new Error('invalid governance transaction journal state')
  if (!Number.isInteger(journal.applied) || journal.applied < 0 || journal.applied > SNAPSHOT_KEYS.length) {
    throw new Error('invalid governance transaction journal progress')
  }
  if ((journal.state === 'prepared' && journal.applied !== 0)
    || (journal.state === 'committed' && journal.applied !== SNAPSHOT_KEYS.length)
    || (journal.state === 'rolled_back' && journal.applied !== 0)) {
    throw new Error('inconsistent governance transaction journal state')
  }
  const snapshots = journal.snapshots
  if (!snapshots || typeof snapshots !== 'object' || Array.isArray(snapshots)
    || Object.keys(snapshots).sort().join(',') !== [...SNAPSHOT_KEYS].sort().join(',')) {
    throw new Error('invalid governance transaction journal snapshots')
  }
  for (const key of SNAPSHOT_KEYS) {
    if (!snapshots[key] || typeof snapshots[key].previous !== 'string' || typeof snapshots[key].next !== 'string') {
      throw new Error(`invalid governance transaction journal ${key} snapshot`)
    }
  }

  const previousIndex = parseSkillIndex(snapshots.index.previous)
  const nextIndex = parseSkillIndex(snapshots.index.next)
  const previousSkill = parseSkillFrontmatter(snapshots.skill.previous)
  const nextSkill = parseSkillFrontmatter(snapshots.skill.next)
  validateGovernanceAudit(snapshots.audit.previous)
  validateGovernanceAudit(snapshots.audit.next)
  if (previousSkill.skillId !== journal.skillId || nextSkill.skillId !== journal.skillId) {
    throw new Error('governance transaction journal skill identity mismatch')
  }
  const previousRecord = previousIndex.skills.find((record) => record.skillId === journal.skillId)
  const nextRecord = nextIndex.skills.find((record) => record.skillId === journal.skillId)
  if (!previousRecord || !nextRecord) throw new Error('governance transaction journal index record missing')
  assertIndexMatchesFrontmatter(previousRecord, previousSkill)
  assertIndexMatchesFrontmatter(nextRecord, nextSkill)
  const expectedTo = transitionFor(journal.action, previousSkill.promotion)
  if (journal.from !== previousSkill.promotion || journal.to !== expectedTo || nextSkill.promotion !== expectedTo) {
    throw new Error('governance transaction journal transition mismatch')
  }
  const expected = appendGovernanceRecords({
    indexText: snapshots.index.previous,
    auditText: snapshots.audit.previous,
    record: previousRecord,
    action: journal.action,
    from: journal.from,
    to: journal.to,
    at: journal.at,
  })
  if (expected.indexText !== snapshots.index.next || expected.auditText !== snapshots.audit.next) {
    throw new Error('governance transaction journal append mismatch')
  }
  return journal
}

async function writeJournal(journalPath, journal) {
  validateJournal(journal)
  await replaceFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`)
}

async function removeJournal(journalPath) {
  await unlink(journalPath)
  await syncDirectory(resolve(journalPath, '..'))
}

function transactionPaths(archiveRoot, journal) {
  return {
    skill: skillPath(archiveRoot, journal.skillId),
    index: resolve(archiveRoot, 'index', 'skills.jsonl'),
    audit: resolve(archiveRoot, 'governance', 'skill-actions.jsonl'),
  }
}

async function readOptional(path) {
  return (await fileExists(path)) ? readFile(path, 'utf8') : ''
}

async function assertRecoverableTargets(archiveRoot, journal) {
  const paths = transactionPaths(archiveRoot, journal)
  for (const key of SNAPSHOT_KEYS) {
    const current = await readOptional(paths[key])
    const snapshot = journal.snapshots[key]
    if (current !== snapshot.previous && current !== snapshot.next) {
      throw new Error(`governance recovery refused: ${key} changed outside the pending transaction`)
    }
  }
  return paths
}

async function applySnapshots({ archiveRoot, journalPath, journal, direction }) {
  const paths = await assertRecoverableTargets(archiveRoot, journal)
  const forward = direction === 'commit'
  journal.state = forward ? 'committed' : 'rolling_back'
  if (!forward) {
    await writeJournal(journalPath, journal)
    injectCrash('recovery_rolling_back')
  }
  const keys = forward ? SNAPSHOT_KEYS : [...SNAPSHOT_KEYS].reverse()
  for (const key of keys) {
    await replaceFile(paths[key], journal.snapshots[key][forward ? 'next' : 'previous'])
    journal.applied = forward ? Math.min(SNAPSHOT_KEYS.length, journal.applied + 1) : Math.max(0, journal.applied - 1)
    if (!forward) {
      await writeJournal(journalPath, journal)
      injectCrash(`recovery_${key}`)
    }
  }
  if (!forward) {
    journal.applied = 0
    journal.state = 'rolled_back'
    await writeJournal(journalPath, journal)
    injectCrash('recovery_rolled_back')
  }
  await removeJournal(journalPath)
}

async function recoverPendingTransaction(archiveRoot, journalPath) {
  if (!(await fileExists(journalPath))) return
  let journal
  try {
    journal = validateJournal(JSON.parse(await readFile(journalPath, 'utf8')))
  } catch (error) {
    throw new Error(`governance recovery refused: ${error.message}`)
  }
  await applySnapshots({
    archiveRoot,
    journalPath,
    journal,
    direction: journal.state === 'committed' ? 'commit' : 'rollback',
  })
}

function injectCrash(stage) {
  if (process.env.SUBAGENT_SKILL_GOVERNANCE_CRASH_AFTER === stage) process.exit(86)
}

async function commitTransaction({ archiveRoot, journalPath, journal }) {
  await writeJournal(journalPath, journal)
  injectCrash('journal_prepared')
  journal.state = 'committing'
  await writeJournal(journalPath, journal)
  injectCrash('state_committing')
  const paths = transactionPaths(archiveRoot, journal)
  try {
    for (const key of SNAPSHOT_KEYS) {
      await replaceFile(paths[key], journal.snapshots[key].next)
      injectCrash(`write_${key}`)
      journal.applied += 1
      await writeJournal(journalPath, journal)
      injectCrash(`apply_${key}`)
    }
    journal.state = 'committed'
    await writeJournal(journalPath, journal)
    injectCrash('state_committed')
    await removeJournal(journalPath)
  } catch (error) {
    try {
      await applySnapshots({ archiveRoot, journalPath, journal, direction: 'rollback' })
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'governance transaction and rollback both failed')
    }
    throw error
  }
}

async function withLock(lockPath, operation) {
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const encoded = `${JSON.stringify({ version: 1, pid: process.pid, token, acquiredAt: new Date().toISOString() })}\n`
  let handle
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      handle = await open(lockPath, 'wx')
      await handle.writeFile(encoded, 'utf8')
      await handle.sync()
      break
    } catch (error) {
      await handle?.close().catch(() => undefined)
      handle = undefined
      if (error?.code !== 'EEXIST') throw error
      let existing
      try {
        existing = JSON.parse(await readFile(lockPath, 'utf8'))
      } catch {
        throw new Error(`governance lock is malformed; refusing stale-lock removal: ${lockPath}`)
      }
      if (!Number.isSafeInteger(existing?.pid) || existing.pid <= 0 || typeof existing.token !== 'string') {
        throw new Error(`governance lock is malformed; refusing stale-lock removal: ${lockPath}`)
      }
      try {
        process.kill(existing.pid, 0)
        throw new Error(`governance lock already held by pid ${existing.pid}: ${lockPath}`)
      } catch (probeError) {
        if (probeError?.code !== 'ESRCH') throw probeError
      }
      const current = await readFile(lockPath, 'utf8').catch(() => undefined)
      if (current !== `${JSON.stringify(existing)}\n`) {
        throw new Error(`governance lock changed while checking staleness: ${lockPath}`)
      }
      await unlink(lockPath)
    }
  }
  if (!handle) throw new Error(`could not acquire governance lock: ${lockPath}`)
  try {
    return await operation()
  } finally {
    await handle.close()
    const current = await readFile(lockPath, 'utf8').catch(() => undefined)
    if (current === encoded) await unlink(lockPath).catch(() => undefined)
  }
}

async function withArchivePathLocks(targetPaths, operation) {
  const releaseLocks = await acquireArchivePathLocks(targetPaths)
  try {
    return await operation()
  } finally {
    await releaseLocks()
  }
}

async function readArchive(basePath) {
  const archiveRoot = resolve(basePath, '.webAgent-archive')
  const indexPath = resolve(archiveRoot, 'index', 'skills.jsonl')
  if (!(await fileExists(indexPath))) throw new Error(`skills index not found: ${indexPath}`)
  const indexText = await readFile(indexPath, 'utf8')
  return { archiveRoot, indexPath, indexText, parsed: parseSkillIndex(indexText) }
}

function skillPath(archiveRoot, skillId) {
  return resolve(archiveRoot, 'skills', `${skillId}.md`)
}

async function listCandidates(basePath, json) {
  const journalPath = resolve(basePath, '.webAgent-archive', 'governance', 'skill-transaction.json')
  if (await fileExists(journalPath)) {
    throw new Error('pending governance transaction requires recovery before listing candidates')
  }
  const archive = await readArchive(basePath)
  const candidates = candidateSkills(archive.parsed)
  for (const record of candidates) {
    const markdown = await readFile(skillPath(archive.archiveRoot, record.skillId), 'utf8')
    assertIndexMatchesFrontmatter(record, parseSkillFrontmatter(markdown))
  }
  if (json) process.stdout.write(`${JSON.stringify(candidates, null, 2)}\n`)
  else if (candidates.length === 0) process.stdout.write('No candidate skills.\n')
  else {
    for (const skill of candidates) {
      process.stdout.write(`${skill.skillId}\t${skill.kind ?? ''}\t${skill.summary ?? ''}\n`)
    }
  }
}

async function mutate(basePath, action, skillId) {
  const archiveRoot = resolve(basePath, '.webAgent-archive')
  const lockPath = resolve(archiveRoot, 'index', 'skills.governance.lock')
  await withLock(lockPath, async () => {
    const governanceRoot = resolve(archiveRoot, 'governance')
    const journalPath = resolve(governanceRoot, 'skill-transaction.json')
    await mkdir(governanceRoot, { recursive: true })
    const auditPath = resolve(governanceRoot, 'skill-actions.jsonl')
    let pendingSkillId
    if (await fileExists(journalPath)) {
      try {
        pendingSkillId = validateJournal(JSON.parse(await readFile(journalPath, 'utf8'))).skillId
      } catch (error) {
        throw new Error(`governance recovery refused: ${error.message}`)
      }
    }
    const lockedTargets = [
      resolve(archiveRoot, 'index', 'skills.jsonl'),
      auditPath,
      skillPath(archiveRoot, skillId),
      ...(pendingSkillId && pendingSkillId !== skillId ? [skillPath(archiveRoot, pendingSkillId)] : []),
    ]
    await withArchivePathLocks(lockedTargets, async () => {
      await recoverPendingTransaction(archiveRoot, journalPath)
      const archive = await readArchive(basePath)
      const record = archive.parsed.skills.find((skill) => skill.skillId === skillId)
      if (!record) throw new Error(`skill not found in index: ${skillId}`)

      const globalPath = skillPath(archive.archiveRoot, skillId)
      const previousMarkdown = await readFile(globalPath, 'utf8')
      const frontmatter = parseSkillFrontmatter(previousMarkdown)
      assertIndexMatchesFrontmatter(record, frontmatter)
      const nextPromotion = transitionFor(action, frontmatter.promotion)
      const nextMarkdown = updateSkillPromotion(previousMarkdown, skillId, nextPromotion).text

      const previousAudit = (await fileExists(auditPath)) ? await readFile(auditPath, 'utf8') : ''
      validateGovernanceAudit(previousAudit)
      const at = new Date().toISOString()
      const appended = appendGovernanceRecords({
        indexText: archive.indexText,
        auditText: previousAudit,
        record,
        action,
        from: frontmatter.promotion,
        to: nextPromotion,
        at,
      })

      await commitTransaction({
        archiveRoot,
        journalPath,
        journal: {
          version: JOURNAL_VERSION,
          transactionId: `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          state: 'prepared',
          applied: 0,
          action,
          skillId,
          from: frontmatter.promotion,
          to: nextPromotion,
          at,
          snapshots: {
            skill: { previous: previousMarkdown, next: nextMarkdown },
            index: { previous: archive.indexText, next: appended.indexText },
            audit: { previous: previousAudit, next: appended.auditText },
          },
        },
      })
      process.stdout.write(`${skillId}: ${frontmatter.promotion} -> ${nextPromotion} at ${at}\n`)
    })
  })
}

async function run() {
  const options = parseArgs(process.argv)
  if (options.help) return process.stdout.write(helpText())
  const basePath = isAbsolute(options.basePath) ? options.basePath : resolve(process.cwd(), options.basePath)
  if (options.action === 'list') return listCandidates(basePath, options.json)
  return mutate(basePath, options.action, options.skillId)
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.stderr.write('run with --help for usage.\n')
  process.exitCode = 1
})
