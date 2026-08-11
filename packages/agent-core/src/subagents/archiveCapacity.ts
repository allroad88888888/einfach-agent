import type { SubagentNodeRecord } from './types'

export interface SubagentArchiveCapacityFile {
  path: string
  content: string
}

export interface SubagentArchiveCapacityMeasurement {
  fileCount: number
  archiveBytes: number
  eventBytes: number
  eventCount: number
  indexBytes: number
  nodeStatePayloadBytes: number
}

const encoder = new TextEncoder()
const EVENT_LOG_SUFFIX = '/events.jsonl'
const INDEX_PATH_PREFIX = '.webAgent-archive/index/'

function byteLength(value: string): number {
  return encoder.encode(value).byteLength
}

function jsonLineCount(value: string): number {
  return value.split('\n').filter((line) => line.trim()).length
}

/** Summarizes the serialized payload retained by one materialized subagent archive. */
export function measureSubagentArchiveCapacity(input: {
  files: Iterable<SubagentArchiveCapacityFile>
  nodes?: readonly SubagentNodeRecord[]
}): SubagentArchiveCapacityMeasurement {
  let fileCount = 0
  let archiveBytes = 0
  let eventBytes = 0
  let eventCount = 0
  let indexBytes = 0

  for (const file of input.files) {
    const bytes = byteLength(file.content)
    fileCount += 1
    archiveBytes += bytes
    if (file.path.endsWith(EVENT_LOG_SUFFIX)) {
      eventBytes += bytes
      eventCount += jsonLineCount(file.content)
    }
    if (file.path.startsWith(INDEX_PATH_PREFIX)) indexBytes += bytes
  }

  return {
    fileCount,
    archiveBytes,
    eventBytes,
    eventCount,
    indexBytes,
    nodeStatePayloadBytes: byteLength(JSON.stringify(input.nodes ?? [])),
  }
}
