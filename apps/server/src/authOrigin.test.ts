import { describe, expect, it } from 'vitest'
import { isHostHeaderThisServer, judgeOriginHeader } from './authOrigin'

const PORT = 3210

describe('isHostHeaderThisServer', () => {
  it('认三种回环主机名，端口必须与实际监听端口一致', () => {
    expect(isHostHeaderThisServer('127.0.0.1:3210', PORT)).toBe(true)
    expect(isHostHeaderThisServer('localhost:3210', PORT)).toBe(true)
    expect(isHostHeaderThisServer('[::1]:3210', PORT)).toBe(true)
    expect(isHostHeaderThisServer('LOCALHOST:3210', PORT)).toBe(true)
  })

  it('端口对不上就拒', () => {
    expect(isHostHeaderThisServer('127.0.0.1:3211', PORT)).toBe(false)
    expect(isHostHeaderThisServer('127.0.0.1', PORT)).toBe(false)
  })

  it('省略端口只在实际监听 80 时成立', () => {
    expect(isHostHeaderThisServer('127.0.0.1', 80)).toBe(true)
    expect(isHostHeaderThisServer('localhost', 80)).toBe(true)
  })

  it('拒 DNS rebinding：Host 是攻击者的域名', () => {
    // rebinding 下 Origin 会变成攻击者自己的域名（同源 POST）或干脆缺席（同源 GET）；
    // Host 是唯一还在说真话的头，这条就是那道防线。
    for (const host of [
      'evil.com:3210',
      'localhost.evil.com:3210',
      '127.0.0.1.evil.com:3210',
      'evil.localhost:3210',
      'notlocalhost:3210',
    ]) {
      expect(isHostHeaderThisServer(host, PORT)).toBe(false)
    }
  })

  it('缺席一律拒——HTTP/1.1 强制要求 Host，缺席只可能是手工构造', () => {
    expect(isHostHeaderThisServer(undefined, PORT)).toBe(false)
    expect(isHostHeaderThisServer('', PORT)).toBe(false)
    expect(isHostHeaderThisServer(['127.0.0.1:3210', 'evil.com'], PORT)).toBe(false)
  })

  it('端口未知（socket 已断）一律拒', () => {
    expect(isHostHeaderThisServer('127.0.0.1:3210', undefined)).toBe(false)
  })

  it('畸形 authority 一律拒，不硬拆', () => {
    for (const host of ['[::1:3210', '::1:3210', '127.0.0.1:abc', '127.0.0.1:0', '127.0.0.1:99999', '[::1]x:3210']) {
      expect(isHostHeaderThisServer(host, PORT)).toBe(false)
    }
  })
})

describe('judgeOriginHeader', () => {
  it('自己的 origin 判同源', () => {
    expect(judgeOriginHeader('http://127.0.0.1:3210', PORT)).toBe('same-origin')
    expect(judgeOriginHeader('http://localhost:3210', PORT)).toBe('same-origin')
    expect(judgeOriginHeader('http://[::1]:3210', PORT)).toBe('same-origin')
  })

  it('跨站页面判跨源——这是简单请求与 <form> POST 的落点', () => {
    for (const origin of [
      'http://evil.com',
      'https://evil.com',
      'http://evil.com:3210',
      'http://127.0.0.1.evil.com:3210',
      'http://127.0.0.1:5173',
      'http://localhost:5173',
    ]) {
      expect(judgeOriginHeader(origin, PORT)).toBe('cross-origin')
    }
  })

  it('字面量 null 判跨源而不是缺席', () => {
    // 沙箱 iframe、file:// 页面、跨源重定向都会发 `Origin: null`，那是攻击者能构造的一种来源。
    // 归到 absent 里就等于给它开一条按「缺席放行」走的旁路。
    expect(judgeOriginHeader('null', PORT)).toBe('cross-origin')
  })

  it('https 同名同端口也判跨源——本 server 只讲明文 HTTP', () => {
    expect(judgeOriginHeader('https://127.0.0.1:3210', PORT)).toBe('cross-origin')
  })

  it('缺席与空串判 absent（怎么处置由 authGuard 裁决）', () => {
    expect(judgeOriginHeader(undefined, PORT)).toBe('absent')
    expect(judgeOriginHeader('', PORT)).toBe('absent')
  })

  it('畸形与重复头判跨源，fail-closed', () => {
    for (const origin of ['127.0.0.1:3210', 'http:/127.0.0.1:3210', 'http://', 'http://[::1:3210']) {
      expect(judgeOriginHeader(origin, PORT)).toBe('cross-origin')
    }
    expect(judgeOriginHeader(['http://127.0.0.1:3210', 'http://evil.com'], PORT)).toBe('cross-origin')
  })

  it('端口未知一律跨源', () => {
    expect(judgeOriginHeader('http://127.0.0.1:3210', undefined)).toBe('cross-origin')
  })
})
