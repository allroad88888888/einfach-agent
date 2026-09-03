import { isAbsolute, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveArchiveRunPath, resolveArchiveRunPaths, safeArchiveSegment } from './subagent-archive-paths.js'

function isInside(parent, child) {
  const difference = relative(parent, child)
  return difference === '' || (!difference.startsWith('..') && !isAbsolute(difference))
}

describe('subagent archive paths', () => {
  it.each([
    [undefined, 'unknown'],
    ['  ', 'unknown'],
    ['.', 'unknown'],
    ['..', 'unknown'],
    [' conversation/run\\id ', 'conversation_run_id'],
    ['a会b', 'a_b'],
    ['会话\t编号', 'unknown'],
    ['run\u0000name\n', 'run_name'],
    ['run-42.7', 'run-42.7'],
  ])('maps %j to a safe archive segment', (value, expected) => {
    expect(safeArchiveSegment(value)).toBe(expected)
  })

  it('keeps every mapped run path inside its archive root', () => {
    const archiveRoot = resolve('/tmp/archive-path-root')
    for (const value of ['', '.', '..', '/', '\\', '  ', '会话\u0000id', 'normal-id']) {
      const runPath = resolveArchiveRunPath(archiveRoot, value, value)
      expect(isInside(archiveRoot, runPath)).toBe(true)
    }
    expect(resolveArchiveRunPaths(archiveRoot, '..', '.')).toEqual({
      eventsPath: resolve(archiveRoot, 'conversations', 'unknown', 'runs', 'unknown', 'events.jsonl'),
      treePath: resolve(archiveRoot, 'conversations', 'unknown', 'runs', 'unknown', 'tree.json'),
    })
  })
})
