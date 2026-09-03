import { isAbsolute, relative, resolve } from 'node:path'

export function safeArchiveSegment(value) {
  const safe = (typeof value === 'string' ? value : '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 96)
  return safe && safe !== '.' && safe !== '..' ? safe : 'unknown'
}

function isInsideArchiveRoot(archiveRoot, candidate) {
  const difference = relative(archiveRoot, candidate)
  return difference === '' || (!difference.startsWith('..') && !isAbsolute(difference))
}

export function resolveArchiveRunPath(archiveRoot, conversationId, runId) {
  const root = resolve(archiveRoot)
  const runPath = resolve(root, 'conversations', safeArchiveSegment(conversationId), 'runs', safeArchiveSegment(runId))
  if (!isInsideArchiveRoot(root, runPath)) throw new Error('archive run path escapes archive root')
  return runPath
}

export function resolveArchiveRunPaths(archiveRoot, conversationId, runId) {
  const runPath = resolveArchiveRunPath(archiveRoot, conversationId, runId)
  return {
    eventsPath: resolve(runPath, 'events.jsonl'),
    treePath: resolve(runPath, 'tree.json'),
  }
}
