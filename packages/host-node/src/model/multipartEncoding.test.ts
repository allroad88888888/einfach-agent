import { describe, expect, it } from 'vitest'
import { encodeMultipartBody } from './multipartEncoding'

const BOUNDARY = 'test-boundary'

function decode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('binary')
}

describe('multipart 编码', () => {
  it('逐字节产出标准 multipart/form-data', () => {
    const encoded = encodeMultipartBody(
      [
        { kind: 'text', name: 'purpose', value: 'file-extract' },
        {
          kind: 'file',
          name: 'file',
          fileName: 'a.png',
          contentType: 'image/png',
          bytes: new Uint8Array([1, 2, 3]),
        },
      ],
      BOUNDARY,
    )
    expect(encoded.contentType).toBe(`multipart/form-data; boundary=${BOUNDARY}`)
    expect(decode(encoded.bytes)).toBe(
      [
        `--${BOUNDARY}`,
        'Content-Disposition: form-data; name="purpose"',
        '',
        'file-extract',
        `--${BOUNDARY}`,
        'Content-Disposition: form-data; name="file"; filename="a.png"',
        'Content-Type: image/png',
        '',
        // 文件字节（base64 'AQID' 解出来的 0x01 0x02 0x03）；写转义而不放字面控制字符。
        '\u0001\u0002\u0003',
        `--${BOUNDARY}--`,
        '',
      ].join('\r\n'),
    )
  })

  it('文件字节原样进 body，不做任何转码', () => {
    // 上传的是二进制。任何一层「顺手转成字符串再转回来」都会把非 UTF-8 字节洗成 U+FFFD，
    // 而症状是上传成功、文件损坏。
    const bytes = new Uint8Array([0x00, 0x80, 0xff, 0xfe])
    const encoded = encodeMultipartBody(
      [{ kind: 'file', name: 'file', fileName: 'a.bin', contentType: 'application/octet-stream', bytes }],
      BOUNDARY,
    )
    const body = Buffer.from(encoded.bytes)
    const start = body.indexOf(Buffer.from('\r\n\r\n')) + 4
    expect(body.subarray(start, start + 4)).toEqual(Buffer.from(bytes))
  })

  it('文件名里的引号被转义，撬不开 Content-Disposition 头', () => {
    // 校验层放行引号（Rust 也放行），所以逃逸只能在编码这一层挡。少了它，一个叫
    // `x"; name="other` 的文件名就能凭空多造一个表单字段。
    const encoded = encodeMultipartBody(
      [
        {
          kind: 'file',
          name: 'file',
          fileName: 'x"; name="other',
          contentType: 'image/png',
          bytes: new Uint8Array([1]),
        },
      ],
      BOUNDARY,
    )
    expect(decode(encoded.bytes)).toContain(
      'Content-Disposition: form-data; name="file"; filename="x\\"; name=\\"other"',
    )
  })

  it('每次生成的 boundary 都不同', () => {
    const parts = [{ kind: 'text', name: 'a', value: 'b' }] as const
    const first = encodeMultipartBody(parts)
    const second = encodeMultipartBody(parts)
    expect(first.contentType).not.toBe(second.contentType)
    expect(first.contentType.startsWith('multipart/form-data; boundary=')).toBe(true)
  })
})
