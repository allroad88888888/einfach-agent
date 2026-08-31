import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveConfigPaths } from './configPaths'
import { createWebAgentConfigStore } from './webAgentConfigStore'

let home: string

const configPath = () => join(home, '.webAgent', 'config.json')

async function store() {
  return createWebAgentConfigStore(await resolveConfigPaths(home, undefined))
}

async function writeConfig(contents: string): Promise<void> {
  await mkdir(dirname(configPath()), { recursive: true })
  await writeFile(configPath(), contents)
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'web-agent-config-transaction-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('配置事务段隔离', () => {
  it('只把授权段的深隔离快照交给回调', async () => {
    await writeConfig(JSON.stringify({
      version: 1,
      alpha: { nested: { count: 1 } },
      modelCredentials: { 'openai-compat:profile:alpha': 'secret' },
      protected: { nested: { enabled: true } },
    }))
    const configStore = await store()

    await configStore.updateSections(['alpha'], (current) => {
      expect([...current.keys()]).toEqual(['alpha'])
      expect(current.get('modelCredentials')).toBeUndefined()
      const alpha = current.get('alpha') as { nested: { count: number } }
      alpha.nested.count = 99
      const mutableCurrent = current as Map<string, unknown>
      mutableCurrent.set('protected', { nested: { enabled: false } })
      return new Map()
    })

    expect(JSON.parse(await readFile(configPath(), 'utf8'))).toEqual({
      version: 1,
      alpha: { nested: { count: 1 } },
      modelCredentials: { 'openai-compat:profile:alpha': 'secret' },
      protected: { nested: { enabled: true } },
    })
  })

  it('返回未授权段时拒绝整个 patch，原文件字节不变', async () => {
    const original = '{"version":1,"alpha":{"count":1},"modelCredentials":{"key":"secret"}}'
    await writeConfig(original)
    const configStore = await store()

    await expect(configStore.updateSections(['alpha'], () => new Map([
      ['alpha', { count: 2 }],
      ['modelCredentials', { key: 'stolen' }],
    ]))).rejects.toThrow('配置事务试图更新未授权段')

    await expect(readFile(configPath(), 'utf8')).resolves.toBe(original)
  })

  it.each([
    { sections: [], message: '配置事务至少需要一个可写段' },
    { sections: ['alpha', 'alpha'], message: '配置事务包含重复段名' },
    { sections: [''], message: '配置事务包含非法段名' },
    { sections: [' alpha'], message: '配置事务包含非法段名' },
    { sections: ['version'], message: '配置事务包含非法段名' },
  ])('在读取或写入前拒绝非法声明 $sections', async ({ sections, message }) => {
    const legacyPath = join(home, '.web-agent', 'config.json')
    await mkdir(dirname(legacyPath), { recursive: true })
    await writeFile(legacyPath, '{"version":1,"alpha":1}')
    const configStore = await store()

    await expect(configStore.updateSections(sections, () => new Map())).rejects.toThrow(message)

    await expect(stat(configPath())).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(legacyPath, 'utf8')).resolves.toBe('{"version":1,"alpha":1}')
  })

  it('声明的多个段都可见并在一次事务中提交', async () => {
    await writeConfig('{"version":1,"modelConnections":{"alpha":{"id":"alpha"}},"modelCredentials":{"alpha":"secret"},"keep":{"nested":true}}')
    const configStore = await store()

    await configStore.updateSections(['modelConnections', 'modelCredentials'], (current) => {
      expect(current.get('modelConnections')).toEqual({ alpha: { id: 'alpha' } })
      expect(current.get('modelCredentials')).toEqual({ alpha: 'secret' })
      expect(current.get('keep')).toBeUndefined()
      return new Map([
        ['modelConnections', { alpha: { id: 'alpha' }, beta: { id: 'beta' } }],
        ['modelCredentials', { alpha: 'secret', beta: 'other-secret' }],
      ])
    })

    expect(JSON.parse(await readFile(configPath(), 'utf8'))).toEqual({
      version: 1,
      keep: { nested: true },
      modelConnections: { alpha: { id: 'alpha' }, beta: { id: 'beta' } },
      modelCredentials: { alpha: 'secret', beta: 'other-secret' },
    })
  })
})
