import { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { readBoundedJsonBody } from './boundedJsonBody'

function requestStream(): { request: IncomingMessage; emitter: EventEmitter } {
  const emitter = new EventEmitter()
  return { request: emitter as unknown as IncomingMessage, emitter }
}

describe('readBoundedJsonBody', () => {
  it('区分空 body、合法 JSON 与损坏 JSON', async () => {
    const empty = requestStream()
    const emptyResult = readBoundedJsonBody(empty.request, 32)
    empty.emitter.emit('end')
    await expect(emptyResult).resolves.toEqual({ kind: 'empty' })

    const json = requestStream()
    const jsonResult = readBoundedJsonBody(json.request, 32)
    json.emitter.emit('data', Buffer.from('{"a":'))
    json.emitter.emit('data', Buffer.from('1}'))
    json.emitter.emit('end')
    await expect(jsonResult).resolves.toEqual({ kind: 'json', value: { a: 1 } })

    const invalid = requestStream()
    const invalidResult = readBoundedJsonBody(invalid.request, 32)
    invalid.emitter.emit('data', Buffer.from('{'))
    invalid.emitter.emit('end')
    await expect(invalidResult).resolves.toEqual({ kind: 'invalid-json' })
  })

  it('按实际跨块字节数拒绝超限，并继续监听后续数据直到 end', async () => {
    const stream = requestStream()
    const result = readBoundedJsonBody(stream.request, 4)
    stream.emitter.emit('data', Buffer.from('123'))
    stream.emitter.emit('data', Buffer.from('45'))
    stream.emitter.emit('data', Buffer.alloc(1024))
    expect(stream.emitter.listenerCount('data')).toBe(1)
    stream.emitter.emit('end')
    await expect(result).resolves.toEqual({ kind: 'too-large' })
    expect(stream.emitter.listenerCount('data')).toBe(0)
  })

  it('传输错误保持 reject，并清理全部监听器', async () => {
    const stream = requestStream()
    const result = readBoundedJsonBody(stream.request, 32)
    stream.emitter.emit('error', 'disconnected')
    await expect(result).rejects.toThrow('disconnected')
    expect(stream.emitter.eventNames()).toEqual([])
  })
})
