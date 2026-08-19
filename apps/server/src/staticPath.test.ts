import { describe, expect, it } from 'vitest'
import { resolveStaticPath } from './staticPath'

function segments(pathname: string): readonly string[] | string {
  const resolution = resolveStaticPath(pathname)
  return resolution.kind === 'segments' ? resolution.segments : `rejected: ${resolution.reason}`
}

describe('resolveStaticPath', () => {
  it('把普通路径切成分段，丢掉空段与 `.`', () => {
    expect(segments('/')).toEqual([])
    expect(segments('/index.html')).toEqual(['index.html'])
    expect(segments('/assets//app.js')).toEqual(['assets', 'app.js'])
    expect(segments('/./assets/./app.js')).toEqual(['assets', 'app.js'])
  })

  it('解码一次百分号编码', () => {
    expect(segments('/assets/%E4%B8%AD%E6%96%87.js')).toEqual(['assets', '中文.js'])
    expect(segments('/a%20b.txt')).toEqual(['a b.txt'])
  })

  // 明文 `../` 在真实 HTTP 栈里到不了 handler（URL 解析会先消掉它），只有直接喂本函数才测得到。
  // 但它必须被拒：本函数的契约是「返回的分段可以直接 join 到根上」，多一条入口就多一次赌。
  it('拒绝明文的 `..`', () => {
    expect(segments('/../secret.txt')).toBe('rejected: 请求路径越出站点根目录。')
    expect(segments('/assets/../../secret.txt')).toBe('rejected: 请求路径越出站点根目录。')
  })

  it('拒绝编码后的 `..`（含大小写与 `\\` 变体）', () => {
    expect(segments('/%2e%2e/secret.txt')).toBe('rejected: 请求路径越出站点根目录。')
    expect(segments('/%2E%2E%2Fsecret.txt')).toBe('rejected: 请求路径越出站点根目录。')
    expect(segments('/..%2f..%2fsecret.txt')).toBe('rejected: 请求路径越出站点根目录。')
    expect(segments('/..%5c..%5csecret.txt')).toBe('rejected: 请求路径越出站点根目录。')
  })

  // 二次编码的防线就是「只解一次」：解一次得到的是字面文件名 `%2e%2e`，不是 `..`。
  // 这条用例同时钉住反面——如果哪天有人在下游补了第二次 decode，它会立刻变成穿越并让本例转红。
  it('二次编码解一次后是普通文件名，不构成穿越', () => {
    expect(segments('/%252e%252e%252fsecret.txt')).toEqual(['%2e%2e%2fsecret.txt'])
    expect(segments('/%252e%252e/secret.txt')).toEqual(['%2e%2e', 'secret.txt'])
  })

  it('拒绝 NUL 与坏编码', () => {
    expect(segments('/index.html%00.png')).toBe('rejected: 请求路径包含非法字符。')
    expect(segments('/%zz')).toBe('rejected: 请求路径的百分号编码不合法。')
    expect(segments('/%')).toBe('rejected: 请求路径的百分号编码不合法。')
  })
})
