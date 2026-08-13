import { describe, expect, it } from 'vitest'
import { createCliPerformanceDiagnosticSink } from './performance-output'

describe('createCliPerformanceDiagnosticSink', () => {
  it('默认丢弃诊断，verbose 时格式化写到 stderr', () => {
    const lines: string[] = []
    const output = { write: (text: string) => lines.push(text) }
    const diagnostic = {
      level: 'warn' as const,
      name: 'cli.render',
      attrs: { operationId: 'render-1', observedDurationMs: 120 },
    }

    createCliPerformanceDiagnosticSink(false, output)(diagnostic)
    expect(lines).toEqual([])

    createCliPerformanceDiagnosticSink(true, output)(diagnostic)
    expect(lines).toEqual(['[perf] warn cli.render {"operationId":"render-1","observedDurationMs":120}\n'])
  })
})
