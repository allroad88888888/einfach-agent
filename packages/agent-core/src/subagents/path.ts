import type { SubagentPath } from './types'

export const ROOT_AGENT_PATH = 'root'
const PATH_SEGMENT_RE = /^(0*[1-9]\d*)$/

function padChildIndex(index: number, width: number): string {
  return String(index).padStart(width, '0')
}

export function parseAgentPath(path: string): number[] | undefined {
  if (path === ROOT_AGENT_PATH) return []
  if (!path.startsWith(`${ROOT_AGENT_PATH}-`)) return undefined

  const segments = path.slice(ROOT_AGENT_PATH.length + 1).split('-')
  if (segments.length === 0) return undefined

  const parsed: number[] = []
  for (const segment of segments) {
    if (!PATH_SEGMENT_RE.test(segment)) return undefined
    const value = Number(segment)
    if (!Number.isSafeInteger(value) || value <= 0) return undefined
    parsed.push(value)
  }
  return parsed
}

export function isAgentPath(path: string): path is SubagentPath {
  return parseAgentPath(path) !== undefined
}

export function assertAgentPath(path: string): asserts path is SubagentPath {
  if (!isAgentPath(path)) throw new Error(`invalid agent path: ${path}`)
}

export function agentPathDepth(path: SubagentPath): number {
  const segments = parseAgentPath(path)
  if (!segments) throw new Error(`invalid agent path: ${path}`)
  return segments.length
}

export function childAgentPath(parentPath: SubagentPath, childIndex: number, width = 2): SubagentPath {
  assertAgentPath(parentPath)
  if (!Number.isSafeInteger(childIndex) || childIndex <= 0) {
    throw new Error(`invalid child index: ${childIndex}`)
  }
  const child = padChildIndex(childIndex, width)
  return parentPath === ROOT_AGENT_PATH ? `${ROOT_AGENT_PATH}-${child}` : `${parentPath}-${child}`
}

export function parentAgentPath(path: SubagentPath): SubagentPath | undefined {
  assertAgentPath(path)
  if (path === ROOT_AGENT_PATH) return undefined
  const lastDash = path.lastIndexOf('-')
  if (lastDash <= ROOT_AGENT_PATH.length) return ROOT_AGENT_PATH
  return path.slice(0, lastDash)
}

export function compareAgentPaths(a: SubagentPath, b: SubagentPath): number {
  const left = parseAgentPath(a)
  const right = parseAgentPath(b)
  if (!left || !right) return a.localeCompare(b)

  const length = Math.max(left.length, right.length)
  for (let i = 0; i < length; i += 1) {
    const av = left[i]
    const bv = right[i]
    if (av === undefined) return -1
    if (bv === undefined) return 1
    if (av !== bv) return av - bv
  }
  return 0
}
