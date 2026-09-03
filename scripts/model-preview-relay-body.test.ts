import { describe, expect, it } from 'vitest'
import { parseRelayEnvelope } from './model-preview-relay-body'

function uploadEnvelope(fileName: string): Uint8Array {
  return Buffer.from(JSON.stringify({
    requestId: 'relay-file-name',
    target: { provider: 'kimi', scope: 'cn', method: 'POST', path: '/files' },
    body: {
      kind: 'multipart',
      parts: [{
        kind: 'file', name: 'file', fileName,
        contentType: 'image/png', bytesBase64: 'AQID',
      }],
    },
  }))
}

describe('preview relay body policy', () => {
  it.each(['a\u0000.png', 'a\u001f.png', 'a\u007f.png', 'a\u0085.png'])(
    'rejects C0/C1 file name %j',
    (fileName) => {
      expect(() => parseRelayEnvelope(uploadEnvelope(fileName)))
        .toThrow('模型开发中继请求格式无效')
    },
  )

  it('preserves allowed Unicode and spaced file names', () => {
    expect(parseRelayEnvelope(uploadEnvelope('截图 1.png')).body).toBeInstanceOf(FormData)
  })
})
