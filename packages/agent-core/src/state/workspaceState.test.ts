import { describe, expect, it } from 'vitest'
import { deriveWorkspaceName } from './workspaceState'

describe('deriveWorkspaceName', () => {
  it('默认使用目录最后一级名称', () => {
    expect(deriveWorkspaceName('/Volumes/work/ai/web-agent')).toBe('web-agent')
  })

  it('目录名超过 40 个字符时保留末尾并限制标题长度', () => {
    const name = deriveWorkspaceName(`/workspace/${'前'.repeat(20)}${'后'.repeat(30)}`)
    expect(Array.from(name)).toHaveLength(40)
    expect(name.startsWith('…')).toBe(true)
    expect(name.endsWith('后'.repeat(30))).toBe(true)
  })
})
