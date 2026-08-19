import { describe, expect, it } from 'vitest'
import { DEFAULT_BIND_ADDRESS, isLoopbackAddress } from './authLoopback'

describe('isLoopbackAddress', () => {
  it('认三种回环写法', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('::1')).toBe(true)
    // 双栈监听套接字上收到的 IPv4 连接，Node 报的就是这种形态；漏了它会把本机请求全拒掉。
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
  })

  it('拒局域网与公网地址', () => {
    for (const address of ['192.168.1.5', '10.0.0.7', '172.16.0.1', '203.0.113.9', '::ffff:192.168.1.5']) {
      expect(isLoopbackAddress(address)).toBe(false)
    }
  })

  it('拒缺席与空串', () => {
    expect(isLoopbackAddress(undefined)).toBe(false)
    expect(isLoopbackAddress('')).toBe(false)
  })

  it('拒前缀相近的地址——判定是整值相等，不是字符串前缀', () => {
    // `127.0.0.1.evil.com` 以 `127.0.0.1` 开头。用 startsWith 写这条判定就会把它放进来。
    expect(isLoopbackAddress('127.0.0.1.evil.com')).toBe(false)
    expect(isLoopbackAddress('127.0.0.10')).toBe(false)
  })

  it('已知收窄：127.0.0.0/8 的其余地址也被拒（fail-closed，与模型开发中继逐字同判据）', () => {
    expect(isLoopbackAddress('127.0.0.2')).toBe(false)
    expect(isLoopbackAddress('127.1.2.3')).toBe(false)
  })
})

describe('DEFAULT_BIND_ADDRESS', () => {
  it('是字面量回环 IP，不是需要解析的名字', () => {
    // 写 'localhost' 的话「绑在哪」要过一次 DNS/hosts 解析，结果可能是 ::1、可能被 hosts 改掉。
    expect(DEFAULT_BIND_ADDRESS).toBe('127.0.0.1')
    expect(isLoopbackAddress(DEFAULT_BIND_ADDRESS)).toBe(true)
  })
})
