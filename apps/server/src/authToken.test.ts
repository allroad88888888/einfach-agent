import { describe, expect, it } from 'vitest'
import { generateAuthToken, readBearerToken, tokenMatches } from './authToken'

describe('generateAuthToken', () => {
  it('每次都不同，且熵不低于 128 bit', () => {
    const tokens = new Set(Array.from({ length: 64 }, () => generateAuthToken()))
    expect(tokens.size).toBe(64)
    // base64url 每字符 6 bit；43 字符 = 258 bit 的编码空间，底下是 32 字节随机源。
    // 断言下界而不是等值，免得把「换更长的 token」变成一次红灯。
    for (const token of tokens) expect(token.length).toBeGreaterThanOrEqual(22)
  })

  it('只用 URL 安全字符——S4 要把它拼进 URL，B2 要用 URLSearchParams 读回来', () => {
    for (let i = 0; i < 64; i += 1) {
      const token = generateAuthToken()
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
      expect(new URLSearchParams(`token=${token}`).get('token')).toBe(token)
    }
  })
})

describe('readBearerToken', () => {
  it('取出 Bearer 值，scheme 大小写不敏感', () => {
    expect(readBearerToken('Bearer abc')).toBe('abc')
    expect(readBearerToken('bearer abc')).toBe('abc')
    expect(readBearerToken('BEARER abc')).toBe('abc')
    expect(readBearerToken('Bearer   abc  ')).toBe('abc')
  })

  it('形状不对一律 undefined，不猜也不兜底', () => {
    expect(readBearerToken(undefined)).toBeUndefined()
    expect(readBearerToken('')).toBeUndefined()
    expect(readBearerToken('abc')).toBeUndefined()
    expect(readBearerToken('Basic abc')).toBeUndefined()
    expect(readBearerToken('Bearer')).toBeUndefined()
    expect(readBearerToken('Bearer ')).toBeUndefined()
    // 重复头会被 Node 收成数组；判无效，免得「取第几个」变成一次需要猜的裁决。
    expect(readBearerToken(['Bearer abc', 'Bearer def'])).toBeUndefined()
  })
})

describe('tokenMatches', () => {
  it('相等为真', () => {
    const token = generateAuthToken()
    expect(tokenMatches(token, token)).toBe(true)
  })

  it('不等为假', () => {
    expect(tokenMatches('abcdef', 'abcdeg')).toBe(false)
    expect(tokenMatches('abcdef', 'ABCDEF')).toBe(false)
  })

  it('长度不等不抛异常——裸 timingSafeEqual 在这里会抛', () => {
    // 这条是回归护栏：直接 timingSafeEqual(Buffer.from(a), Buffer.from(b)) 会抛
    // "Input buffers must have the same byte length"，把一次拒绝变成一个 500。
    expect(() => tokenMatches('abc', 'abcdefghijklmnop')).not.toThrow()
    expect(tokenMatches('abc', 'abcdefghijklmnop')).toBe(false)
    expect(tokenMatches('abc', '')).toBe(false)
    expect(tokenMatches('', 'abc')).toBe(false)
  })

  it('前缀相同不为真——短路比较会在这里把长度信息漏出去', () => {
    const token = generateAuthToken()
    expect(tokenMatches(token, token.slice(0, token.length - 1))).toBe(false)
    expect(tokenMatches(token, `${token}x`)).toBe(false)
  })

  it('多字节输入不会因编码而误判', () => {
    expect(tokenMatches('令牌', '令牌')).toBe(true)
    expect(tokenMatches('令牌', '令牘')).toBe(false)
  })
})
