import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveConfigPaths } from './configPaths'
import { createWebAgentConfigStore } from './webAgentConfigStore'

const isUnix = process.platform !== 'win32'

let home: string

const newPath = () => join(home, '.webAgent', 'config.json')
const legacyPath = () => join(home, '.web-agent', 'config.json')

async function defaultStore() {
  return createWebAgentConfigStore(await resolveConfigPaths(home, undefined))
}

async function writeConfig(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents)
}

async function missing(path: string): Promise<boolean> {
  return stat(path).then(
    () => false,
    () => true,
  )
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'web-agent-config-store-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('配置段的读改写', () => {
  it('文件不存在、段不存在都读成 undefined', async () => {
    const store = await defaultStore()
    await expect(store.readSection('mcp')).resolves.toBeUndefined()

    await writeConfig(newPath(), '{"version":1,"otherSetting":{"enabled":true}}')
    await expect(store.readSection('mcp')).resolves.toBeUndefined()
  })

  it('写一个段不动其余顶层键', async () => {
    await writeConfig(
      newPath(),
      '{"version":1,"modelCredentials":{"deepseek:default":"test-key"},"otherSetting":{"enabled":true}}',
    )
    const store = await defaultStore()

    await store.updateSection('mcp', () => ({ servers: ['local'] }))

    const config = JSON.parse(await readFile(newPath(), 'utf8'))
    expect(config).toEqual({
      version: 1,
      mcp: { servers: ['local'] },
      // 同一份文件里还住着模型凭证：Node 宿主写 mcp 段时不能把它们抹掉。
      modelCredentials: { 'deepseek:default': 'test-key' },
      otherSetting: { enabled: true },
    })
  })

  it('回调返回 undefined 删除该段，version 保留', async () => {
    await writeConfig(newPath(), '{"version":1,"mcp":{"servers":[]}}')
    const store = await defaultStore()

    await store.updateSection('mcp', () => undefined)

    await expect(store.readSection('mcp')).resolves.toBeUndefined()
    expect(JSON.parse(await readFile(newPath(), 'utf8'))).toEqual({ version: 1 })
  })

  it('回调抛错时文件原样不动', async () => {
    await writeConfig(newPath(), '{"version":1,"mcp":{"servers":[]}}')
    const store = await defaultStore()

    await expect(
      store.updateSection('mcp', () => {
        throw new Error('拒绝写入')
      }),
    ).rejects.toThrow('拒绝写入')

    await expect(readFile(newPath(), 'utf8')).resolves.toBe('{"version":1,"mcp":{"servers":[]}}')
  })

  it('损坏的配置文件读写都受控失败，且不被覆盖', async () => {
    await writeConfig(newPath(), '{ not json')
    const store = await defaultStore()

    await expect(store.readSection('mcp')).rejects.toThrow('模型配置文件格式无效')
    await expect(store.updateSection('mcp', () => ({}))).rejects.toThrow('模型配置文件格式无效')
    // 损坏比丢失更糟：这里绝不能「修复」成一份空配置，那会把用户的凭证一并丢掉。
    await expect(readFile(newPath(), 'utf8')).resolves.toBe('{ not json')
  })

  it('不认识的版本号受控失败，缺 version 当作 1', async () => {
    await writeConfig(newPath(), '{"version":2,"mcp":{}}')
    await expect((await defaultStore()).readSection('mcp')).rejects.toThrow(
      '模型配置文件版本不受支持',
    )

    await writeConfig(newPath(), '{"mcp":{"servers":["local"]}}')
    await expect((await defaultStore()).readSection('mcp')).resolves.toEqual({
      servers: ['local'],
    })
  })

  it('version 写成 null 或字符串都是格式错误', async () => {
    await writeConfig(newPath(), '{"version":null,"mcp":{}}')
    await expect((await defaultStore()).readSection('mcp')).rejects.toThrow('模型配置文件格式无效')

    await writeConfig(newPath(), '{"version":"1","mcp":{}}')
    await expect((await defaultStore()).readSection('mcp')).rejects.toThrow('模型配置文件格式无效')
  })

  it('落盘时 version 在前、其余段按键排序', async () => {
    const store = await defaultStore()
    await store.updateSection('zeta', () => 1)
    await store.updateSection('alpha', () => 2)

    // 同一份文件会被桌面宿主和 Node 宿主轮流写；两边排序不一致会让每次换宿主都产生整份 diff。
    await expect(readFile(newPath(), 'utf8')).resolves.toBe(
      '{\n  "version": 1,\n  "alpha": 2,\n  "zeta": 1\n}',
    )
  })
})

describe('旧配置迁移', () => {
  const legacyContents = '{"version":1,"modelCredentials":{"deepseek:default":"old-key"}}'

  it('默认路径 + 新文件不存在 → 复制旧文件，且旧文件保留', async () => {
    await writeConfig(legacyPath(), legacyContents)

    await expect((await defaultStore()).readSection('modelCredentials')).resolves.toEqual({
      'deepseek:default': 'old-key',
    })
    // 逐字复制，不重新序列化：新旧两份是不是同一份要有逐字判据。
    await expect(readFile(newPath(), 'utf8')).resolves.toBe(legacyContents)
    // 旧文件不删不改——迁移失败或用户退回旧版时它还得在。
    await expect(readFile(legacyPath(), 'utf8')).resolves.toBe(legacyContents)
  })

  it('默认路径 + 新文件已存在 → 不复制，新文件优先', async () => {
    await writeConfig(legacyPath(), '{"version":1,"mcp":{"servers":["legacy"]}}')
    await writeConfig(newPath(), '{"version":1,"mcp":{"servers":["new"]}}')

    await expect((await defaultStore()).readSection('mcp')).resolves.toEqual({
      servers: ['new'],
    })
    await expect(readFile(legacyPath(), 'utf8')).resolves.toBe(
      '{"version":1,"mcp":{"servers":["legacy"]}}',
    )
  })

  it('设了覆盖目录 → 既不读也不迁移旧文件', async () => {
    const override = join(home, 'profile-work')
    // 旧文件故意是坏的：真去读它就会抛错，抛不出来才证明它根本没被碰。
    await writeConfig(legacyPath(), 'not valid json')
    const store = createWebAgentConfigStore(await resolveConfigPaths(home, override))

    await expect(store.readSection('mcp')).resolves.toBeUndefined()
    expect(await missing(join(override, 'config.json'))).toBe(true)
    expect(await missing(newPath())).toBe(true)
    await expect(readFile(legacyPath(), 'utf8')).resolves.toBe('not valid json')
  })

  it('默认路径 + 旧文件也不存在 → 空配置，不创建任何文件', async () => {
    await expect((await defaultStore()).readSection('mcp')).resolves.toBeUndefined()
    expect(await missing(newPath())).toBe(true)
  })

  it('旧文件解析不过时受控失败，且不创建新文件', async () => {
    await writeConfig(legacyPath(), 'not valid json')

    await expect((await defaultStore()).readSection('mcp')).rejects.toThrow(
      '旧模型配置文件格式无效',
    )
    // 先落一份坏配置再报错，等于把损坏搬到了新路径上。
    expect(await missing(newPath())).toBe(true)
  })

  it('旧路径不可读（是个目录）时受控失败，且不创建新文件', async () => {
    await mkdir(legacyPath(), { recursive: true })

    await expect((await defaultStore()).readSection('mcp')).rejects.toThrow(
      '无法读取旧模型配置文件',
    )
    expect(await missing(newPath())).toBe(true)
  })

  it.runIf(isUnix)('迁移出来的目录是 0700、文件是 0600', async () => {
    await writeConfig(legacyPath(), legacyContents)
    // 旧目录可以是宽松权限，迁过来必须收紧——否则迁移本身就是一次凭证降级。
    await chmod(join(home, '.web-agent'), 0o755)

    await (await defaultStore()).readSection('modelCredentials')

    expect((await stat(join(home, '.webAgent'))).mode & 0o777).toBe(0o700)
    expect((await stat(newPath())).mode & 0o777).toBe(0o600)
  })
})
