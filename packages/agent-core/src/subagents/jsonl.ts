export interface JsonlParseError {
  line: number
  raw: string
  error: string
}

export interface JsonlParseResult<T> {
  records: T[]
  parseErrors: JsonlParseError[]
}

export interface JsonlLine {
  lineNumber: number
  content: string
}

export interface JsonlRecordParser<T> {
  parse(value: unknown): T | undefined
  invalidRecordError: string
}

function parseError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

/** Parses JSON Lines while retaining malformed-line locations for archive diagnostics. */
export function parseJsonlLines<T>(
  lines: readonly JsonlLine[],
  parser: JsonlRecordParser<T>,
): JsonlParseResult<T> {
  const records: T[] = []
  const parseErrors: JsonlParseError[] = []

  for (const line of lines) {
    const raw = line.content.trim()
    if (!raw) continue
    try {
      const record = parser.parse(JSON.parse(raw) as unknown)
      if (record === undefined) {
        parseErrors.push({ line: line.lineNumber, raw, error: parser.invalidRecordError })
        continue
      }
      records.push(record)
    } catch (error) {
      parseErrors.push({ line: line.lineNumber, raw, error: parseError(error, 'invalid json line') })
    }
  }

  return { records, parseErrors }
}

export function parseJsonl<T>(
  text: string,
  parser: JsonlRecordParser<T>,
): JsonlParseResult<T> {
  return parseJsonlLines(
    text.split(/\r?\n/).map((content, index) => ({ lineNumber: index + 1, content })),
    parser,
  )
}

/** Parses one archive JSON document with the same diagnostic shape as JSON Lines. */
export function parseJsonDocument(text: string): JsonlParseResult<unknown> {
  const trimmed = text.trim()
  if (!trimmed) return { records: [], parseErrors: [] }
  try {
    return { records: [JSON.parse(trimmed) as unknown], parseErrors: [] }
  } catch (error) {
    return {
      records: [],
      parseErrors: [{ line: 1, raw: text, error: parseError(error, 'invalid json') }],
    }
  }
}
