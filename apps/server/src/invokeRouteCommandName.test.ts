import { describe, expect, it } from 'vitest'
import { isInvokeRoutePath, resolveInvokeCommandName } from './invokeRouteCommandName'

describe('isInvokeRoutePath', () => {
  it('匹配 /api/invoke/ 前缀', () => {
    expect(isInvokeRoutePath('/api/invoke/get_user_home_dir')).toBe(true)
    expect(isInvokeRoutePath('/api/invoke/')).toBe(true)
  })

  it('不匹配缺少末尾斜杠、或前缀相似但不同的路径', () => {
    expect(isInvokeRoutePath('/api/invoke')).toBe(false)
    expect(isInvokeRoutePath('/api/invoke-other/foo')).toBe(false)
    expect(isInvokeRoutePath('/api/health')).toBe(false)
  })
})

describe('resolveInvokeCommandName', () => {
  it('原样取出命令名段', () => {
    expect(resolveInvokeCommandName('/api/invoke/get_user_home_dir')).toBe('get_user_home_dir')
  })

  it('解码恰好一次', () => {
    // %5F 解码一次得到 `_`。
    expect(resolveInvokeCommandName('/api/invoke/get%5Fuser%5Fhome%5Fdir')).toBe('get_user_home_dir')
  })

  it('不做二次解码：双重编码的分隔符不会被消成一个真分隔符', () => {
    // %252e 解码一次是字面量 `%2e`，不是 `.`；如果这里解码了两次就会变成 `.`。
    expect(resolveInvokeCommandName('/api/invoke/%252e%252e')).toBe('%2e%2e')
  })

  it('解码失败时回落到未解码原串，而不是抛错', () => {
    expect(resolveInvokeCommandName('/api/invoke/%zz')).toBe('%zz')
  })

  it('空分段与含斜杠的分段原样返回，交给 invoke() 判定是否合法', () => {
    expect(resolveInvokeCommandName('/api/invoke/')).toBe('')
    expect(resolveInvokeCommandName('/api/invoke/foo/bar')).toBe('foo/bar')
  })
})
