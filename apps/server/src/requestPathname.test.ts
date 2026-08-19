import { describe, expect, it } from 'vitest'
import { requestPathname } from './requestPathname'

describe('requestPathname', () => {
  it('origin-form 原样返回，只去掉查询串与片段', () => {
    expect(requestPathname('/assets/app.js')).toBe('/assets/app.js')
    expect(requestPathname('/api/health?verbose=1')).toBe('/api/health')
    expect(requestPathname('/index.html#anchor')).toBe('/index.html')
    expect(requestPathname(undefined)).toBe('/')
    expect(requestPathname('')).toBe('/')
  })

  // 本函数存在的全部理由：`new URL('/%2e%2e/x', base).pathname` 是 `/x`——URL 规范会就地消掉
  // `%2e%2e` 这种 dot segment。归一发生在判定之前，等于把路径的权威劈成两处。
  it('不做 dot-segment 归一，编码过的穿越形态原样交给判定层', () => {
    expect(requestPathname('/%2e%2e/secret.txt')).toBe('/%2e%2e/secret.txt')
    expect(requestPathname('/../secret.txt')).toBe('/../secret.txt')
    expect(requestPathname('/a/%2e%2e/%2e%2e/secret.txt')).toBe('/a/%2e%2e/%2e%2e/secret.txt')
    expect(requestPathname('/.%2e/secret.txt')).toBe('/.%2e/secret.txt')
  })

  it('absolute-form 取 URL 的 pathname，解析不了的落到根', () => {
    expect(requestPathname('http://127.0.0.1:5173/assets/app.js')).toBe('/assets/app.js')
    expect(requestPathname('nonsense')).toBe('/')
  })
})
