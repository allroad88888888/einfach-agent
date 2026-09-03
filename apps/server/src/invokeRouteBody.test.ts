import { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { readInvokeRouteBody } from './invokeRouteBody'

/** 造一个足够假装成 IncomingMessage 的替身：真 EventEmitter + headers 属性。 */
function fakeRequest(headers: Record<string, string> = {}): { request: IncomingMessage, emitter: EventEmitter } {
  const emitter = new EventEmitter()
  const request = Object.assign(emitter, { headers }) as unknown as IncomingMessage
  return { request, emitter }
}

describe('readInvokeRouteBody', () => {
  it('空 body 返回 empty', async () => {
    const { request, emitter } = fakeRequest()
    const pending = readInvokeRouteBody(request, 1024)
    emitter.emit('end')
    await expect(pending).resolves.toEqual({ kind: 'empty' })
  })

  it('合法 JSON 对象逐字段透传，不填任何默认值、保留显式 null', async () => {
    const { request, emitter } = fakeRequest()
    const pending = readInvokeRouteBody(request, 1024)
    emitter.emit('data', Buffer.from('{"path":"a.txt","weird_KEY":null}'))
    emitter.emit('end')
    await expect(pending).resolves.toEqual({
      kind: 'object',
      value: { path: 'a.txt', weird_KEY: null },
    })
  })

  it('多个 data 事件跨块累积后再解析', async () => {
    const { request, emitter } = fakeRequest()
    const pending = readInvokeRouteBody(request, 1024)
    emitter.emit('data', Buffer.from('{"a":'))
    emitter.emit('data', Buffer.from('1}'))
    emitter.emit('end')
    await expect(pending).resolves.toEqual({ kind: 'object', value: { a: 1 } })
  })

  it.each([
    ['数组', '[1,2,3]'],
    ['字符串', '"hello"'],
    ['数字', '42'],
    ['布尔', 'true'],
    ['null', 'null'],
  ])('顶层是%s时判 not-object', async (_label, json) => {
    const { request, emitter } = fakeRequest()
    const pending = readInvokeRouteBody(request, 1024)
    emitter.emit('data', Buffer.from(json))
    emitter.emit('end')
    await expect(pending).resolves.toEqual({ kind: 'not-object' })
  })

  it('损坏的 JSON 判 invalid-json', async () => {
    const { request, emitter } = fakeRequest()
    const pending = readInvokeRouteBody(request, 1024)
    emitter.emit('data', Buffer.from('{not json'))
    emitter.emit('end')
    await expect(pending).resolves.toEqual({ kind: 'invalid-json' })
  })

  it('累积字节数一超过上限即判 too-large，按实际收到的字节数而非 Content-Length', async () => {
    const { request, emitter } = fakeRequest()
    const pending = readInvokeRouteBody(request, 4)
    emitter.emit('data', Buffer.from('12345')) // 5 字节，单块就超过 4 字节上限
    emitter.emit('end')
    await expect(pending).resolves.toEqual({ kind: 'too-large' })
  })

  it('超限后仍消费后续 data 事件，但不再累积内存、也不改变结果', async () => {
    const { request, emitter } = fakeRequest()
    const pending = readInvokeRouteBody(request, 2)
    emitter.emit('data', Buffer.from('abc'))
    emitter.emit('data', Buffer.from('def'))
    emitter.emit('end')
    await expect(pending).resolves.toEqual({ kind: 'too-large' })
  })

  it('流上的 error 事件让 promise reject，而不是解析出某个 kind', async () => {
    const { request, emitter } = fakeRequest()
    const pending = readInvokeRouteBody(request, 1024)
    emitter.emit('error', new Error('boom'))
    await expect(pending).rejects.toThrow('boom')
  })
})
