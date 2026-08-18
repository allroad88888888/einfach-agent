import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { spawnRg } from './spawnRg'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'host-node-rg-spawn-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function waitForClose(child: { once: (event: 'close', cb: () => void) => unknown }): Promise<void> {
  await new Promise<void>((resolve) => child.once('close', resolve))
}

describe('spawnRg：rg 缺失时给可读错误，而不是裸 ENOENT 堆栈', () => {
  it('二进制不存在 → reject，消息带 Rust 原文前缀 + 安装指引', async () => {
    await expect(
      spawnRg({
        root,
        target: '.',
        query: 'needle',
        regex: false,
        caseSensitive: true,
        globs: [],
        contextLines: 0,
        binary: 'rg-definitely-does-not-exist-12345',
      }),
    ).rejects.toThrow(
      /failed to spawn `rg-definitely-does-not-exist-12345`.*ripgrep.*https:\/\/github\.com\/BurntSushi\/ripgrep/s,
    )
  })
})

// 跳过条件：只在 POSIX 上跑——CI 的 `pnpm test` 固定在 ubuntu-latest，本机是 macOS，
// 都满足；写 shebang 脚本当「假 rg」不依赖真实 ripgrep 是否安装，纯测参数拼装。
const describePosix = process.platform === 'win32' ? describe.skip : describe

describePosix('spawnRg：参数拼装（用 shebang 脚本录 argv，不依赖真实 rg 是否安装）', () => {
  it('顺序与开关：--fixed-strings / --ignore-case / --context 按输入条件出现，globs 逐个 --glob', async () => {
    const scriptPath = join(root, 'fake-rg.sh')
    await writeFile(scriptPath, '#!/bin/sh\nprintf \'%s\\n\' "$@" > argv.txt\n')
    await chmod(scriptPath, 0o755)

    const child = await spawnRg({
      root,
      target: 'src',
      query: 'needle',
      regex: false,
      caseSensitive: true,
      globs: ['*.ts', '!*.test.ts'],
      contextLines: 3,
      binary: scriptPath,
    })
    await waitForClose(child)

    const argv = (await readFile(join(root, 'argv.txt'), 'utf8')).split('\n').filter((line) => line !== '')
    expect(argv).toEqual([
      '--json',
      '--color',
      'never',
      '--line-number',
      '--column',
      '--with-filename',
      '--max-filesize',
      '1M',
      '--fixed-strings',
      '--context',
      '3',
      '--glob',
      '*.ts',
      '--glob',
      '!*.test.ts',
      '--regexp',
      'needle',
      'src',
    ])
  })

  it('regex=true 省略 --fixed-strings；caseSensitive=false 追加 --ignore-case；contextLines=0 省略 --context', async () => {
    const scriptPath = join(root, 'fake-rg.sh')
    await writeFile(scriptPath, '#!/bin/sh\nprintf \'%s\\n\' "$@" > argv.txt\n')
    await chmod(scriptPath, 0o755)

    const child = await spawnRg({
      root,
      target: '.',
      query: 'a.*b',
      regex: true,
      caseSensitive: false,
      globs: [],
      contextLines: 0,
      binary: scriptPath,
    })
    await waitForClose(child)

    const argv = (await readFile(join(root, 'argv.txt'), 'utf8')).split('\n').filter((line) => line !== '')
    expect(argv).toEqual([
      '--json',
      '--color',
      'never',
      '--line-number',
      '--column',
      '--with-filename',
      '--max-filesize',
      '1M',
      '--ignore-case',
      '--regexp',
      'a.*b',
      '.',
    ])
  })
})
