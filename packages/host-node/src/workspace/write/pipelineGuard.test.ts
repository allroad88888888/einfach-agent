import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createWriteFixture, type WriteFixture } from './pipeline.testHarness'

let fixture: WriteFixture

beforeEach(async () => {
  fixture = await createWriteFixture()
})

afterEach(async () => {
  await fixture.cleanup()
})

const HASH_OF_ABC = 'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'

const readBack = (relative: string): Promise<string> =>
  readFile(join(fixture.root, relative), 'utf8')

describe('乐观守卫贯穿流水线', () => {
  it('expectedOldContent 不匹配时拒绝覆盖，磁盘保持原样', async () => {
    await writeFile(join(fixture.root, 'code.txt'), 'current\n')
    const result = await fixture.write({
      path: 'code.txt',
      content: 'next\n',
      mode: 'overwrite',
      expectedOldContent: 'stale\n',
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('expectedOldContent does not match current file content')
    expect(result.error).toContain('do not pass a snippet')
    expect(result.path).toBe('code.txt')
    expect(await readBack('code.txt')).toBe('current\n')
  })

  it('expectedContentHash 匹配就放行，不匹配就拒并指出要重读', async () => {
    await writeFile(join(fixture.root, 'code.txt'), 'abc')
    const accepted = await fixture.write({
      path: 'code.txt',
      content: 'next',
      mode: 'overwrite',
      expectedContentHash: HASH_OF_ABC,
    })
    expect(accepted.ok).toBe(true)
    expect(await readBack('code.txt')).toBe('next')

    // 文件已经变了，同一个 hash 现在必须挡住。
    const rejected = await fixture.write({
      path: 'code.txt',
      content: 'again',
      mode: 'overwrite',
      expectedContentHash: HASH_OF_ABC,
    })
    expect(rejected.ok).toBe(false)
    expect(rejected.error).toContain('the file changed after read_file')
    expect(await readBack('code.txt')).toBe('next')
  })

  it('append 也收守卫——过期 hash 挡住重复追加', async () => {
    await writeFile(join(fixture.root, 'log.jsonl'), 'abc')
    const stale = await fixture.write({
      path: 'log.jsonl',
      content: 'two\n',
      mode: 'append',
      expectedContentHash: `sha256:${'0'.repeat(64)}`,
    })
    expect(stale.ok).toBe(false)
    expect(await readBack('log.jsonl')).toBe('abc')

    const fresh = await fixture.write({
      path: 'log.jsonl',
      content: 'two\n',
      mode: 'append',
      expectedContentHash: HASH_OF_ABC,
    })
    expect(fresh.ok).toBe(true)
    expect(await readBack('log.jsonl')).toBe('abctwo\n')
  })

  it('create + 守卫互斥（create 要求文件不存在，守卫要求它是某个样子）', async () => {
    const result = await fixture.write({
      path: 'a.txt',
      content: 'x',
      mode: 'create',
      expectedOldContent: 'anything',
    })
    expect(result.ok).toBe(false)
    expect(result.error).toBe(
      'optimistic guards are not valid with mode "create"; the file must not exist',
    )
  })

  it('两种守卫不能同时给', async () => {
    await writeFile(join(fixture.root, 'a.txt'), 'abc')
    const result = await fixture.write({
      path: 'a.txt',
      content: 'x',
      mode: 'overwrite',
      expectedOldContent: 'abc',
      expectedContentHash: HASH_OF_ABC,
    })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('pass either expectedOldContent or expectedContentHash, not both')
  })

  it('upsert + 守卫撞上不存在的文件时拒绝静默新建', async () => {
    const result = await fixture.write({
      path: 'absent.txt',
      content: 'x',
      mode: 'upsert',
      expectedOldContent: 'expected old',
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('does not exist')
    await expect(readBack('absent.txt')).rejects.toThrow()
  })

  it('dry run 下守卫不匹配同样报错', async () => {
    await writeFile(join(fixture.root, 'code.txt'), 'current\n')
    const result = await fixture.write({
      path: 'code.txt',
      content: 'next\n',
      mode: 'overwrite',
      expectedOldContent: 'stale\n',
      dryRun: true,
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('expectedOldContent')
  })
})

describe('守卫与写锁的配合', () => {
  it('并发覆盖同一路径时，只有一个能通过守卫', async () => {
    // 这条钉的是「临界区整段在锁里」。没有锁的话两次调用会各自在 await 处让出、**都**读到
    // 初始内容 `abc`、于是**两个守卫都通过**，后写的那份整份覆盖前一个——而调用方两边都收到
    // `ok: true`。那正是乐观守卫要拦的事，也正是它自己在无锁时的失效方式。
    await writeFile(join(fixture.root, 'shared.txt'), 'abc')
    const attempt = (content: string): ReturnType<WriteFixture['write']> =>
      fixture.write({
        path: 'shared.txt',
        content,
        mode: 'overwrite',
        expectedContentHash: HASH_OF_ABC,
      })

    const [first, second] = await Promise.all([attempt('A'), attempt('B')])
    const accepted = [first, second].filter((result) => result.ok)
    const rejected = [first, second].filter((result) => !result.ok)

    expect(accepted).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0].error).toContain('the file changed after read_file')
    // 磁盘上是那个通过的写入的内容，不是两次交错后的残余。
    expect(['A', 'B']).toContain(await readBack('shared.txt'))
  })

  it('不同路径互不排队（锁的粒度是路径，不是一条全局队列）', async () => {
    const results = await Promise.all([
      fixture.write({ path: 'one.txt', content: '1' }),
      fixture.write({ path: 'two.txt', content: '2' }),
    ])
    expect(results.every((result) => result.ok)).toBe(true)
    expect(await readBack('one.txt')).toBe('1')
    expect(await readBack('two.txt')).toBe('2')
  })
})
