import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveConfigPaths } from './configPaths'

const isUnix = process.platform !== 'win32'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'web-agent-config-paths-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('resolveConfigPaths', () => {
  it('默认走 ~/.webAgent/config.json，并允许迁移旧的 ~/.web-agent/config.json', async () => {
    // 两个目录名只差一个连字符，写错任何一个都不会报错、只会读到空配置。
    await expect(resolveConfigPaths(home, undefined)).resolves.toEqual({
      path: join(home, '.webAgent', 'config.json'),
      legacyPath: join(home, '.web-agent', 'config.json'),
    })
  })

  it('覆盖目录换掉配置文件位置，并让迁移在机制上不可能发生', async () => {
    const override = join(home, 'profile-work')
    // legacyPath 为 undefined 才是「不迁移」的实现方式：靠某处记得写 if 会漏。
    await expect(resolveConfigPaths(home, override)).resolves.toEqual({
      path: join(override, 'config.json'),
      legacyPath: undefined,
    })
  })

  it('空值受控失败，不静默回落默认目录', async () => {
    // `WEB_AGENT_CONFIG_DIR=` 回落默认目录 = 用户以为在用隔离配置、实际写的是主配置。
    await expect(resolveConfigPaths(home, '')).rejects.toThrow('WEB_AGENT_CONFIG_DIR 不能为空')
  })

  it('相对路径受控失败', async () => {
    await expect(resolveConfigPaths(home, 'another-profile')).rejects.toThrow(
      'WEB_AGENT_CONFIG_DIR 必须是绝对路径',
    )
  })

  it('指向已存在的文件时受控失败', async () => {
    const target = join(home, 'config-file')
    await writeFile(target, 'not a directory')
    await expect(resolveConfigPaths(home, target)).rejects.toThrow(
      'WEB_AGENT_CONFIG_DIR 必须是目录',
    )
  })

  it.runIf(isUnix)('已存在的目录必须是 0700，且不擅自修改它的权限', async () => {
    const shared = join(home, 'shared-config')
    await mkdir(shared)
    await chmod(shared, 0o755)

    await expect(resolveConfigPaths(home, shared)).rejects.toThrow(
      'WEB_AGENT_CONFIG_DIR 目录权限必须为 0700',
    )
    // 不顺手 chmod：用户可能指错了路径，那样会把别人的目录改成私有。
    expect((await stat(shared)).mode & 0o777).toBe(0o755)
  })

  it.runIf(isUnix)('已存在且恰为 0700 的目录放行', async () => {
    const private_ = join(home, 'private-config')
    await mkdir(private_)
    await chmod(private_, 0o700)

    await expect(resolveConfigPaths(home, private_)).resolves.toEqual({
      path: join(private_, 'config.json'),
      legacyPath: undefined,
    })
  })
})
