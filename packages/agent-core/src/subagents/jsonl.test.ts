import { describe, expect, it } from 'vitest'
import { parseJsonDocument, parseJsonl, parseJsonlLines } from './jsonl'

describe('subagent JSONL parser', () => {
  it('retains physical line numbers across blank, invalid, and malformed records', () => {
    const result = parseJsonl('  \r\n{"id":"one"}\r\n{broken}\r\n{"other":true}\n', {
      parse: (value) => {
        if (!value || typeof value !== 'object' || !('id' in value)) return undefined
        return value as { id: string }
      },
      invalidRecordError: 'invalid record',
    })

    expect(result.records).toEqual([{ id: 'one' }])
    expect(result.parseErrors).toMatchObject([
      { line: 3, raw: '{broken}' },
      { line: 4, raw: '{"other":true}', error: 'invalid record' },
    ])
  })

  it('uses supplied paged line numbers and keeps JSON-document diagnostics compatible', () => {
    const result = parseJsonlLines([
      { lineNumber: 18, content: '{"id":"one"}' },
      { lineNumber: 19, content: '{broken}' },
    ], {
      parse: (value) => value as { id: string },
      invalidRecordError: 'unused',
    })

    expect(result.records).toEqual([{ id: 'one' }])
    expect(result.parseErrors[0]).toMatchObject({ line: 19, raw: '{broken}' })
    expect(parseJsonDocument('{broken}').parseErrors[0]).toMatchObject({ line: 1, raw: '{broken}' })
  })
})
