import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CONFIG_DIRECTORY_ENV } from './configPaths'
import { createConfigRoutes } from './index'

let home: string
let savedOverride: string | undefined

const configPath = () => join(home, '.webAgent', 'config.json')
const legacyPath = () => join(home, '.web-agent', 'config.json')

function routes() {
  const table = createConfigRoutes({ homeDir: home })
  const read = table.mcp_config_read
  const write = table.mcp_config_write
  if (!read || !write) throw new Error('config 域必须同时提供两条 mcp_config_* 命令')
  return { read, write }
}

async function writeFileAt(path: string, contents: string): Promise<void> {
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
  home = await mkdtemp(join(tmpdir(), 'web-agent-mcp-commands-'))
  // 开发机上真设了这个变量时，不隔离的话本文件会去写用户的真实配置目录。
  savedOverride = process.env[CONFIG_DIRECTORY_ENV]
  delete process.env[CONFIG_DIRECTORY_ENV]
})

afterEach(async () => {
  if (savedOverride === undefined) delete process.env[CONFIG_DIRECTORY_ENV]
  else process.env[CONFIG_DIRECTORY_ENV] = savedOverride
  await rm(home, { recursive: true, force: true })
})

describe('mcp_config_read / mcp_config_write', () => {
  it('默认读写装配槽 homeDir 下的 .webAgent/config.json', async () => {
    const { read, write } = routes()

    await write({ patch: { servers: ['local'] } })

    // 路径写死成 os.homedir() 的话，这条会去动运行测试那个人的真实配置。
    expect(JSON.parse(await readFile(configPath(), 'utf8'))).toEqual({
      version: 1,
      mcp: { servers: ['local'] },
    })
    await expect(read({})).resolves.toEqual({ servers: ['local'] })
  })

  it('读命令不看 args——多传的键不构成另一种行为', async () => {
    await writeFileAt(configPath(), '{"version":1,"mcp":{"servers":["local"]}}')
    const { read } = routes()

    await expect(read({ section: 'modelCredentials' })).resolves.toEqual({ servers: ['local'] })
  })

  it('写命令缺 patch 时受控失败，不当成空补丁', async () => {
    const { write } = routes()

    // 判缺席只看值：core 的 toTauriInput 会让可选键存在且为 undefined，而 HTTP 那条路上
    // JSON.stringify 又会把它丢掉——用 `'patch' in args` 判会两边行为不一致。
    await expect(write({})).rejects.toThrow('mcp_config_write 缺少 patch 参数')
    await expect(write({ patch: undefined })).rejects.toThrow('mcp_config_write 缺少 patch 参数')
    expect(await missing(configPath())).toBe(true)
  })

  it('WEB_AGENT_CONFIG_DIR 换掉配置目录，且不触发旧配置迁移', async () => {
    const override = join(home, 'profile-work')
    await writeFileAt(legacyPath(), '{"version":1,"mcp":{"servers":["legacy"]}}')
    process.env[CONFIG_DIRECTORY_ENV] = override
    const { read, write } = routes()

    // 覆盖目录下没有配置 → 空段。读到 legacy 的内容就说明迁移越界了。
    await expect(read({})).resolves.toEqual({})
    await write({ patch: { servers: ['isolated'] } })

    expect(JSON.parse(await readFile(join(override, 'config.json'), 'utf8'))).toEqual({
      version: 1,
      mcp: { servers: ['isolated'] },
    })
    // 默认目录始终没被创建，旧文件也原封不动。
    expect(await missing(configPath())).toBe(true)
    await expect(readFile(legacyPath(), 'utf8')).resolves.toBe(
      '{"version":1,"mcp":{"servers":["legacy"]}}',
    )
  })

  it('WEB_AGENT_CONFIG_DIR 不合法时受控失败，不回落默认目录', async () => {
    process.env[CONFIG_DIRECTORY_ENV] = 'relative-profile'
    const { read, write } = routes()

    await expect(read({})).rejects.toThrow('WEB_AGENT_CONFIG_DIR 必须是绝对路径')
    await expect(write({ patch: {} })).rejects.toThrow('WEB_AGENT_CONFIG_DIR 必须是绝对路径')
    expect(await missing(configPath())).toBe(true)
  })

  it('WEB_AGENT_CONFIG_DIR 只选目录：它带不进也带不出模型 Key', async () => {
    // 环境变量的用途是多实例隔离。这里把一个「像 Key」的值塞进去，它只会被当作路径，
    // 既不会成为凭证，也不会出现在任何返回值里。
    process.env[CONFIG_DIRECTORY_ENV] = 'sk-not-a-path-just-a-secret'
    const { read } = routes()

    const error = await read({}).then(
      () => undefined,
      (reason: unknown) => reason,
    )
    expect((error as Error).message).toBe('WEB_AGENT_CONFIG_DIR 必须是绝对路径')
    expect((error as Error).message).not.toContain('sk-not-a-path')
  })

  it('读命令会触发默认路径下的旧配置迁移，且旧文件保留', async () => {
    const legacy = '{"version":1,"mcp":{"servers":["legacy"]}}'
    await writeFileAt(legacyPath(), legacy)
    const { read } = routes()

    await expect(read({})).resolves.toEqual({ servers: ['legacy'] })
    await expect(readFile(configPath(), 'utf8')).resolves.toBe(legacy)
    await expect(readFile(legacyPath(), 'utf8')).resolves.toBe(legacy)
  })
})
