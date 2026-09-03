import { describe, expect, it } from 'vitest'
import { normalizeApiKey, readModelCredentialSnapshotKey } from './credentialSection'

describe('modelCredentials section codec', () => {
  it('reads only a string member from a valid section', () => {
    expect(readModelCredentialSnapshotKey({ 'deepseek:default': ' key ' }, 'deepseek:default'))
      .toBe(' key ')
  })

  it('leaves API key acceptance to the shared normalizer', () => {
    expect(normalizeApiKey(' key ')).toBe('key')
    expect(normalizeApiKey('   ')).toBeUndefined()
    expect(normalizeApiKey('k'.repeat(1_025))).toBeUndefined()
  })

  it.each([
    'not-a-map',
    [],
    null,
    { 'deepseek:default': 1 },
  ])('rejects a section with non-string members: %j', (section) => {
    expect(() => readModelCredentialSnapshotKey(section, 'deepseek:default'))
      .toThrow('模型配置文件格式无效')
  })
})
