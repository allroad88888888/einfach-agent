const INDEX_NAMES = ['runs', 'skills', 'agents']

function asNonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function subagentIndexKey(name, record) {
  if (!INDEX_NAMES.includes(name)) throw new Error(`unsupported subagent index: ${name}`)
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error(`${name} index record must be an object`)
  }

  if (name === 'skills') {
    const skillId = asNonEmptyString(record.skillId)
    if (!skillId) throw new Error('skills index record requires skillId')
    return skillId
  }

  const conversationId = asNonEmptyString(record.conversationId)
  const runId = asNonEmptyString(record.runId)
  if (!conversationId || !runId) {
    throw new Error(`${name} index record requires conversationId and runId`)
  }
  if (name === 'runs') return `${conversationId}\u0000${runId}`

  const path = asNonEmptyString(record.path)
  if (!path) throw new Error('agents index record requires path')
  return `${conversationId}\u0000${runId}\u0000${path}`
}

export function compactSubagentIndex(name, text) {
  const latest = new Map()
  let records = 0

  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim()
    if (!line) return
    let record
    try {
      record = JSON.parse(line)
    } catch (error) {
      throw new Error(`${name} index line ${index + 1}: invalid JSON (${error.message})`)
    }

    let key
    try {
      key = subagentIndexKey(name, record)
    } catch (error) {
      throw new Error(`${name} index line ${index + 1}: ${error.message}`)
    }
    records += 1
    latest.set(key, { record, lineNumber: index + 1 })
  })

  const compacted = [...latest.values()]
    .sort((left, right) => left.lineNumber - right.lineNumber)
    .map(({ record }) => JSON.stringify(record))

  return {
    text: compacted.length ? `${compacted.join('\n')}\n` : '',
    records,
    uniqueRecords: compacted.length,
    removedRecords: records - compacted.length,
  }
}

export const SUBAGENT_INDEX_NAMES = Object.freeze([...INDEX_NAMES])
