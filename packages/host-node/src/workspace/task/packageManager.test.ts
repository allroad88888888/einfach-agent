import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { detectPackageManager } from './packageManager'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'host-node-task-pm-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('detectPackageManager', () => {
  it('都探测不到时默认 npm', async () => {
    await expect(detectPackageManager(root, {})).resolves.toBe('npm')
  })

  it('lockfile 优先于 package.json 的 packageManager 字段', async () => {
    await writeFile(join(root, 'pnpm-lock.yaml'), '')
    await expect(detectPackageManager(root, { packageManager: 'yarn@4.0.0' })).resolves.toBe('pnpm')
  })

  it.each([
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lock', 'bun'],
    ['bun.lockb', 'bun'],
    ['package-lock.json', 'npm'],
    ['npm-shrinkwrap.json', 'npm'],
  ] as const)('%s → %s', async (lockfile, expected) => {
    await writeFile(join(root, lockfile), '')
    await expect(detectPackageManager(root, {})).resolves.toBe(expected)
  })

  it('没有 lockfile 时退回 package.json 的 packageManager 字段（带版本号）', async () => {
    await expect(detectPackageManager(root, { packageManager: 'pnpm@8.6.0' })).resolves.toBe('pnpm')
  })

  it('packageManager 字段接受不带版本号的裸名字', async () => {
    await expect(detectPackageManager(root, { packageManager: 'bun' })).resolves.toBe('bun')
  })

  it('packageManager 字段不是字符串时忽略，落回默认 npm', async () => {
    await expect(detectPackageManager(root, { packageManager: 42 })).resolves.toBe('npm')
  })

  it('packageManager 字段是无法识别的值时忽略，落回默认 npm', async () => {
    await expect(detectPackageManager(root, { packageManager: 'deno@1.0.0' })).resolves.toBe('npm')
  })
})
