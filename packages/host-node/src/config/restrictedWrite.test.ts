import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeRestrictedAtomically } from './restrictedWrite'

const isUnix = process.platform !== 'win32'

let base: string

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'web-agent-restricted-write-'))
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('writeRestrictedAtomically', () => {
  it('递归创建缺失的配置目录并写入内容', async () => {
    const path = join(base, '.webAgent', 'config.json')
    await writeRestrictedAtomically(path, '{"version":1}')
    await expect(readFile(path, 'utf8')).resolves.toBe('{"version":1}')
  })

  it.runIf(isUnix)('新建的配置目录是 0700、配置文件是 0600', async () => {
    // 文件里有模型 API Key。继承 umask 决定的权限意味着「同机其他账号可读」，而那不会报错。
    const path = join(base, '.webAgent', 'config.json')
    await writeRestrictedAtomically(path, '{"version":1}')

    expect((await stat(join(base, '.webAgent'))).mode & 0o777).toBe(0o700)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it.runIf(isUnix)('覆盖一个权限过宽的既有配置文件时收紧它', async () => {
    const path = join(base, 'config.json')
    await writeFile(path, 'old', { mode: 0o644 })

    await writeRestrictedAtomically(path, 'new')

    // rename 带过来的是临时文件的权限，所以覆盖旧文件也会顺带修正权限。
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    await expect(readFile(path, 'utf8')).resolves.toBe('new')
  })

  it('写完不留临时文件', async () => {
    const path = join(base, 'config.json')
    await writeRestrictedAtomically(path, 'a')
    await writeRestrictedAtomically(path, 'b')

    expect((await readdir(base)).sort()).toEqual(['config.json'])
  })

  it('发布失败时不留临时文件、也不动别的文件', async () => {
    const path = join(base, 'config.json')
    await writeFile(path, 'original')
    // 目标是非空目录时 rename 必然失败，这是「发布这一步炸了」的可造场景。
    const blocked = join(base, 'blocked')
    await mkdir(blocked)
    await writeFile(join(blocked, 'keep'), 'x')

    await expect(writeRestrictedAtomically(blocked, 'new')).rejects.toThrow('无法更新模型配置文件')

    await expect(readFile(path, 'utf8')).resolves.toBe('original')
    expect((await readdir(base)).sort()).toEqual(['blocked', 'config.json'])
  })

  it('路径没有文件名时受控失败', async () => {
    await expect(writeRestrictedAtomically('/', 'x')).rejects.toThrow('模型配置文件路径无效')
  })
})
