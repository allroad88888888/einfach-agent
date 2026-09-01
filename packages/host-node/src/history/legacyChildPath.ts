import { realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

const AGENT_PATH = /^root(?:-0*[1-9]\d*)+$/
const ARCHIVE_PREFIX = '.webAgent-archive'

export function normalizeLegacyArchiveSegment(value: string): string {
  const safe = value.trim().replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 96)
  return safe || 'unknown'
}

function contained(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

async function assertExistingContainment(root: string, path: string): Promise<void> {
  let cursor = path
  while (true) {
    try {
      const existing = await realpath(cursor)
      if (!contained(root, existing)) throw new Error('Legacy child path escapes workspace root')
      return
    } catch (error) {
      if (error instanceof Error && error.message.includes('escapes workspace')) throw error
      const parent = dirname(cursor)
      if (parent === cursor) return
      cursor = parent
    }
  }
}

export async function resolveLegacyRunIndexPath(legacyWorkspaceRoot: string): Promise<{
  readonly workspaceRoot: string
  readonly runIndexPath: string
}> {
  if (!isAbsolute(legacyWorkspaceRoot)) throw new Error('Legacy workspace root must be absolute')
  const workspaceRoot = await realpath(legacyWorkspaceRoot)
  const runIndexPath = resolve(workspaceRoot, ARCHIVE_PREFIX, 'index', 'runs.jsonl')
  await assertExistingContainment(workspaceRoot, runIndexPath)
  return { workspaceRoot, runIndexPath }
}

export async function resolveLegacyRunLocator(input: {
  readonly workspaceRoot: string
  readonly conversationId: string
  readonly runId: string
  readonly archiveBasePath: string
}): Promise<string> {
  const expected = `${ARCHIVE_PREFIX}/conversations/${normalizeLegacyArchiveSegment(input.conversationId)}`
    + `/runs/${normalizeLegacyArchiveSegment(input.runId)}`
  if (input.archiveBasePath !== expected || isAbsolute(input.archiveBasePath)) {
    throw new Error('Legacy archive locator does not match its logical IDs')
  }
  const runDirectory = resolve(input.workspaceRoot, input.archiveBasePath)
  if (!contained(input.workspaceRoot, runDirectory)) throw new Error('Legacy child path escapes workspace root')
  await assertExistingContainment(input.workspaceRoot, runDirectory)
  return runDirectory
}

export async function resolveLegacyTracePath(
  runDirectory: string,
  agentPath: string,
  workspaceRoot: string,
): Promise<string> {
  if (!AGENT_PATH.test(agentPath) || isAbsolute(agentPath)) throw new Error('Invalid legacy child agentPath')
  const tracePath = resolve(runDirectory, 'traces', `${normalizeLegacyArchiveSegment(agentPath)}.trace.jsonl`)
  if (!contained(workspaceRoot, tracePath)) throw new Error('Legacy child path escapes workspace root')
  await assertExistingContainment(workspaceRoot, tracePath)
  return tracePath
}
