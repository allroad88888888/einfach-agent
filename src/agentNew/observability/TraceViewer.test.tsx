import { describe, expect, it } from 'vitest'
import { tracePreviewRows } from './TraceViewer'

describe('TraceViewer preview rows', () => {
  it('reads tool preview fields from attrs', () => {
    expect(
      tracePreviewRows({
        requestPreview: '{"messages":[{"role":"user","content":"hi"}]}',
        responsePreview: '{"choices":[{"message":{"content":"done"}}]}',
        argsPreview: '{"command":"pwd"}',
        resultPreview: { stdout: '/tmp' },
        errorPreview: 'exit 1',
        validationError: 'missing command',
        args: { redacted: true },
      }),
    ).toEqual([
      { key: 'requestPreview', label: 'request', value: '{"messages":[{"role":"user","content":"hi"}]}' },
      { key: 'responsePreview', label: 'response', value: '{"choices":[{"message":{"content":"done"}}]}' },
      { key: 'argsPreview', label: 'args', value: '{"command":"pwd"}' },
      { key: 'resultPreview', label: 'result', value: '{\n  "stdout": "/tmp"\n}' },
      { key: 'errorPreview', label: 'error', value: 'exit 1' },
      { key: 'validationError', label: 'validation', value: 'missing command' },
    ])
  })
})
