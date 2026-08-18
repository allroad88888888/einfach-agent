import { mkdir, rename, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fingerprintOrNull, pathFingerprint } from './pathOpsFingerprint'
import { createTempWorkspace, type TempWorkspace } from '../common/tempWorkspace.testHarness'

let workspace: TempWorkspace

beforeEach(async () => {
  workspace = await createTempWorkspace()
})

afterEach(async () => {
  await workspace.cleanup()
})

function at(...segments: string[]): string {
  return join(workspace.root, ...segments)
}

async function seedTree(root: string): Promise<void> {
  await mkdir(join(root, 'inner'), { recursive: true })
  await writeFile(join(root, 'top.txt'), 'top')
  await writeFile(join(root, 'inner', 'deep.txt'), 'deep')
}

describe('pathFingerprint', () => {
  it('内容相同的两棵树指纹相同（可以放心用它判「没被动过」）', async () => {
    await seedTree(at('one'))
    await seedTree(at('two'))

    expect(await pathFingerprint(at('one'))).toBe(await pathFingerprint(at('two')))
  })

  it('内容变了指纹就变', async () => {
    await seedTree(at('tree'))
    const before = await pathFingerprint(at('tree'))
    await writeFile(at('tree', 'top.txt'), 'changed')

    expect(await pathFingerprint(at('tree'))).not.toBe(before)
  })

  it('只改名不改内容，指纹也要变——只哈希内容的话这一步会漏掉', async () => {
    await seedTree(at('tree'))
    const before = await pathFingerprint(at('tree'))
    await rename(at('tree', 'top.txt'), at('tree', 'renamed.txt'))

    expect(await pathFingerprint(at('tree'))).not.toBe(before)
  })

  it('文件指纹与目录指纹不会相撞：判别字节 `file\\0` / `dir\\0` 就是干这个的', async () => {
    await writeFile(at('a.txt'), '')
    await mkdir(at('a-dir'))

    expect(await pathFingerprint(at('a.txt'))).not.toBe(await pathFingerprint(at('a-dir')))
  })

  it('含符号链接就拒', async () => {
    await mkdir(at('tree'))
    await writeFile(at('tree', 'ok.txt'), 'ok')
    await symlink(at('tree', 'ok.txt'), at('tree', 'link.txt'))

    await expect(pathFingerprint(at('tree'))).rejects.toThrow('symbolic links are not supported')
  })

  it('路径不存在时抛，而不是给一个「空树」的指纹', async () => {
    await expect(pathFingerprint(at('missing'))).rejects.toThrow('failed to inspect')
  })
})

describe('fingerprintOrNull', () => {
  it('算得出来就给指纹', async () => {
    await writeFile(at('a.txt'), 'a')
    expect(await fingerprintOrNull(at('a.txt'))).toBe(await pathFingerprint(at('a.txt')))
  })

  it('算不出来给 null——回滚侧要的是「对不上」，不是一个异常', async () => {
    expect(await fingerprintOrNull(at('missing'))).toBeNull()
  })
})
