import { describe, expect, it } from 'vitest'
import { narrowProviderRequestEnvelope } from './requestEnvelope'

const canonical = {
  target: { provider: 'deepseek', scope: 'default', method: 'POST', path: '/chat/completions' },
  body: { kind: 'json', json: '{}' },
  requestId: 'request-1',
}

describe('信封收窄', () => {
  it('规范信封原样收下，键序与 Rust 结构体一致', () => {
    const envelope = narrowProviderRequestEnvelope(canonical)
    expect(envelope).toEqual(canonical)
    // 键序不是洁癖：大小上限量的是 JSON.stringify 的字节数，而 stringify 按插入序输出。
    // 两个宿主要对同一份请求量出同一个数，键序就得对齐。
    expect(Object.keys(envelope)).toEqual(['target', 'body', 'requestId'])
    expect(Object.keys(envelope.target)).toEqual(['provider', 'scope', 'method', 'path'])
  })

  it('拒绝顶层多余字段', () => {
    expect(() => narrowProviderRequestEnvelope({ ...canonical, events: {} })).toThrow(
      '模型请求格式无效',
    )
  })

  it('requestId 先判，报的是 ID 的错而不是笼统的格式错', () => {
    // 顺序有意义：一个拼错的 ID 被说成「整份请求格式有问题」时，调用方会去查 body。
    for (const requestId of ['', 'request with spaces', 'a'.repeat(129), 42, undefined]) {
      expect(() => narrowProviderRequestEnvelope({ ...canonical, requestId })).toThrow(
        '模型请求 ID 无效',
      )
    }
  })

  it('整份信封有硬顶，且在 body 解码之前就量', () => {
    const encoded = Buffer.byteLength(JSON.stringify(canonical), 'utf8')
    expect(() => narrowProviderRequestEnvelope(canonical, encoded)).not.toThrow()
    expect(() => narrowProviderRequestEnvelope(canonical, encoded - 1)).toThrow('模型请求格式无效')
  })

  it('单看每条限额都合规的一堆分片，加起来会被信封挡下', () => {
    // 这就是信封上限存在的理由：分片数 × 单片上限这个乘积远超任何一条单项限额。
    const parts = Array.from({ length: 8 }, (_, index) => ({
      kind: 'file',
      name: `f${index}`,
      fileName: 'a.png',
      contentType: 'image/png',
      bytesBase64: 'A'.repeat(4 * 1024),
    }))
    const oversized = {
      target: { provider: 'kimi', scope: 'cn', method: 'POST', path: '/files' },
      body: { kind: 'multipart', parts },
      requestId: 'request-1',
    }
    expect(() => narrowProviderRequestEnvelope(oversized, 16 * 1024)).toThrow('模型请求格式无效')
  })
})
