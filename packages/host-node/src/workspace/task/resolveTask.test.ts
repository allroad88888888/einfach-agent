import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveTask, taskCommand } from './resolveTask'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'host-node-task-resolve-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function writePackageJson(content: unknown): Promise<void> {
  await writeFile(join(root, 'package.json'), JSON.stringify(content))
}

describe('resolveTask · package-script kind', () => {
  it('package.json 不存在时报错，文案带上路径', async () => {
    await expect(resolveTask(root, 'test')).rejects.toThrow(/failed to read `.*package\.json`/)
  })

  it('package.json 不是合法 JSON 时报错', async () => {
    await writeFile(join(root, 'package.json'), '{not json')
    await expect(resolveTask(root, 'test')).rejects.toThrow(/failed to parse `.*package\.json`/)
  })

  it('缺 scripts 对象时报错', async () => {
    await writePackageJson({ name: 'x' })
    await expect(resolveTask(root, 'test')).rejects.toThrow('package.json is missing a `scripts` object')
  })

  it('对应 script 缺失时报错，消息点名具体 script', async () => {
    await writePackageJson({ scripts: { build: 'tsc' } })
    await expect(resolveTask(root, 'test')).rejects.toThrow(
      'package.json is missing a non-empty `test` script',
    )
  })

  it('对应 script 是空白字符串时同样算缺失', async () => {
    await writePackageJson({ scripts: { test: '   ' } })
    await expect(resolveTask(root, 'test')).rejects.toThrow(
      'package.json is missing a non-empty `test` script',
    )
  })

  it('script 存在时拼出 `<包管理器> run <script>`，默认 npm', async () => {
    await writePackageJson({ scripts: { test: 'vitest run' } })
    const task = await resolveTask(root, 'test')
    expect(task).toEqual({ program: 'npm', args: ['run', 'test'] })
    expect(taskCommand(task)).toEqual(['npm', 'run', 'test'])
  })

  it('lockfile 存在时按探测到的包管理器拼命令', async () => {
    await writePackageJson({ scripts: { lint: 'eslint .' } })
    await writeFile(join(root, 'pnpm-lock.yaml'), '')
    const task = await resolveTask(root, 'lint')
    expect(task).toEqual({ program: 'pnpm', args: ['run', 'lint'] })
  })

  it('四个 package-script kind 都映射到同名 script', async () => {
    await writePackageJson({
      scripts: { test: 'a', build: 'b', lint: 'c', typecheck: 'd' },
    })
    await expect(resolveTask(root, 'build')).resolves.toEqual({ program: 'npm', args: ['run', 'build'] })
    await expect(resolveTask(root, 'typecheck')).resolves.toEqual({
      program: 'npm',
      args: ['run', 'typecheck'],
    })
  })
})

describe('resolveTask · cargo_check', () => {
  it('根目录有 Cargo.toml 时直接 `cargo check`，不带 manifest-path', async () => {
    await writeFile(join(root, 'Cargo.toml'), '[package]\nname = "x"\n')
    await expect(resolveTask(root, 'cargo_check')).resolves.toEqual({
      program: 'cargo',
      args: ['check'],
    })
  })

  it('根目录没有但 apps/desktop/Cargo.toml 存在时带上 manifest-path（正斜杠）', async () => {
    await mkdir(join(root, 'apps', 'desktop'), { recursive: true })
    await writeFile(join(root, 'apps', 'desktop', 'Cargo.toml'), '[package]\nname = "x"\n')
    await expect(resolveTask(root, 'cargo_check')).resolves.toEqual({
      program: 'cargo',
      args: ['check', '--manifest-path', 'apps/desktop/Cargo.toml'],
    })
  })

  it('前两处都没有但 src-tauri/Cargo.toml 存在时用它', async () => {
    await mkdir(join(root, 'src-tauri'), { recursive: true })
    await writeFile(join(root, 'src-tauri', 'Cargo.toml'), '[package]\nname = "x"\n')
    await expect(resolveTask(root, 'cargo_check')).resolves.toEqual({
      program: 'cargo',
      args: ['check', '--manifest-path', 'src-tauri/Cargo.toml'],
    })
  })

  it('根目录优先于 apps/desktop（两者都存在时选根目录、不带 manifest-path）', async () => {
    await writeFile(join(root, 'Cargo.toml'), '[package]\nname = "x"\n')
    await mkdir(join(root, 'apps', 'desktop'), { recursive: true })
    await writeFile(join(root, 'apps', 'desktop', 'Cargo.toml'), '[package]\nname = "y"\n')
    await expect(resolveTask(root, 'cargo_check')).resolves.toEqual({
      program: 'cargo',
      args: ['check'],
    })
  })

  it('三处都没有时报错，文案逐字对齐 Rust', async () => {
    await expect(resolveTask(root, 'cargo_check')).rejects.toThrow(
      'cargo_check requires `Cargo.toml`, `apps/desktop/Cargo.toml`, or `src-tauri/Cargo.toml` in the workspace',
    )
  })
})
