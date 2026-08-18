import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTempWorkspace, type TempWorkspace } from '../common/tempWorkspace.testHarness'
import { createRunWorkspaceTaskHandler } from './runWorkspaceTaskHandler'

// 全文件都显式传 workspace_root，从不省略——省略会让 resolveWorkspaceRoot 退回 git 派生，
// 而测试进程的 cwd 就在本仓库里，那会让 handler 真的对本仓库的 package.json 跑一次
// `npm run test`（本仓库这个 script 就是 `vitest`），递归拉起真实测试进程。

const handler = createRunWorkspaceTaskHandler({})

let workspace: TempWorkspace

beforeEach(async () => {
  workspace = await createTempWorkspace()
})

afterEach(async () => {
  await workspace.cleanup()
})

async function writePackageJson(content: unknown): Promise<void> {
  await writeFile(join(workspace.root, 'package.json'), JSON.stringify(content))
}

describe('run_workspace_task handler · 入参收窄', () => {
  it('kind 缺失时 reject（Node 独有的失败面，Rust 在反序列化阶段就会挡下）', async () => {
    await expect(handler({})).rejects.toThrow('run_workspace_task 缺少 kind 参数')
  })

  it('kind 类型不对时 reject', async () => {
    await expect(handler({ kind: 42 })).rejects.toThrow('run_workspace_task 缺少 kind 参数')
  })

  it('timeout_ms 类型不对时 reject', async () => {
    await expect(handler({ kind: 'test', timeout_ms: 'soon' })).rejects.toThrow(
      'run_workspace_task 的 timeout_ms 必须是数字',
    )
  })

  it('workspace_root 类型不对时 reject', async () => {
    await expect(handler({ kind: 'test', workspace_root: 123 })).rejects.toThrow(
      'run_workspace_task 的 workspace_root 必须是字符串',
    )
  })
})

describe('run_workspace_task handler · 早期失败走 ok:false，不是 reject', () => {
  it('非法 kind：command 为空、cwd 为空、kind 回显 trim 后的原值', async () => {
    const result = await handler({ kind: '  deploy  ', workspace_root: workspace.root })
    expect(result).toMatchObject({
      ok: false,
      exitCode: 1,
      command: [],
      cwd: '',
      kind: 'deploy',
    })
    expect((result as { stderr: string }).stderr).toContain('unsupported task kind `deploy`')
  })

  it('workspace_root 解析不了：cwd 仍是空字符串（在 resolveWorkspaceRoot 那一步就失败了）', async () => {
    const result = await handler({
      kind: 'test',
      workspace_root: join(workspace.root, 'no-such-dir'),
    })
    expect(result).toMatchObject({ ok: false, command: [], cwd: '' })
  })

  it('workspace_root 存在但不是目录：cwd 回显那个路径', async () => {
    const filePath = join(workspace.base, 'not-a-dir')
    await writeFile(filePath, 'x')
    const result = await handler({ kind: 'test', workspace_root: filePath })
    expect(result).toMatchObject({ ok: false, command: [], cwd: filePath })
    expect((result as { stderr: string }).stderr).toContain('is not a directory')
  })

  it('package.json 缺对应 script：cwd 回显 workspace root，command 仍是空', async () => {
    await writePackageJson({ scripts: { build: 'x' } })
    const result = await handler({ kind: 'test', workspace_root: workspace.root })
    expect(result).toMatchObject({ ok: false, command: [], cwd: workspace.root, kind: 'test' })
    expect((result as { stderr: string }).stderr).toContain(
      'package.json is missing a non-empty `test` script',
    )
  })

  it('cargo_check 找不到任何 Cargo.toml', async () => {
    const result = await handler({ kind: 'cargo_check', workspace_root: workspace.root })
    expect(result).toMatchObject({ ok: false, command: [], cwd: workspace.root, kind: 'cargo_check' })
    expect((result as { stderr: string }).stderr).toContain('cargo_check requires')
  })
})

describe('run_workspace_task handler · 真的跑起来', () => {
  it('成功：ok true、exitCode 0、stdout 有内容、command 是 [npm, run, test]', async () => {
    await writePackageJson({ scripts: { test: "node -e \"console.log('hello-from-task')\"" } })

    const result = (await handler({ kind: 'test', workspace_root: workspace.root })) as Record<
      string,
      unknown
    >

    expect(result).toMatchObject({
      ok: true,
      exitCode: 0,
      timedOut: false,
      truncated: false,
      command: ['npm', 'run', 'test'],
      cwd: workspace.root,
      kind: 'test',
    })
    expect(result.stdout).toContain('hello-from-task')
    expect(typeof result.durationMs).toBe('number')
  })

  it('脚本非零退出：ok false、exitCode 透传', async () => {
    await writePackageJson({ scripts: { lint: 'node -e "process.exit(3)"' } })

    const result = await handler({ kind: 'lint', workspace_root: workspace.root })

    expect(result).toMatchObject({ ok: false, exitCode: 3, timedOut: false, command: ['npm', 'run', 'lint'] })
  })

  it('stderr 被捕获', async () => {
    await writePackageJson({
      scripts: { lint: 'node -e "process.stderr.write(\'boom\'); process.exit(1)"' },
    })

    const result = (await handler({ kind: 'lint', workspace_root: workspace.root })) as Record<
      string,
      unknown
    >

    expect(result.stderr).toContain('boom')
    expect(result.ok).toBe(false)
  })

  it('输出超过 max_output_chars 时按上限截断', async () => {
    // 不断言 stdout 的具体内容——`npm run` 会在脚本输出前先印一段 `> test\n> node -e ...`
    // 的横幅，占用的字符数不受本代码控制。这里只断言「截断确实生效」这个契约本身：长度
    // 恰好卡在上限、truncated 标记为真。逐字节的截断正确性已经在 readWorkspaceTaskOutput.test.ts
    // 用可控的假流验证过。
    await writePackageJson({
      scripts: { test: 'node -e "process.stdout.write(\'0123456789\')"' },
    })

    const result = (await handler({
      kind: 'test',
      workspace_root: workspace.root,
      max_output_chars: 4,
    })) as Record<string, unknown>

    expect(result.stdout).toHaveLength(4)
    expect(result.truncated).toBe(true)
    expect(result.ok).toBe(true) // 截断不影响退出码判定的 ok
  })

  it('超时：timedOut true、ok false、很快返回（不会傻等脚本自然结束）', async () => {
    await writePackageJson({ scripts: { test: 'node -e "setTimeout(() => {}, 10000)"' } })
    const startedAt = Date.now()

    const result = (await handler({
      kind: 'test',
      workspace_root: workspace.root,
      timeout_ms: 150,
    })) as Record<string, unknown>

    expect(result).toMatchObject({ ok: false, timedOut: true, exitCode: -1 })
    expect(Date.now() - startedAt).toBeLessThan(5_000)
  })

  it('包管理器按 lockfile 探测：pnpm-lock.yaml 存在时用 pnpm', async () => {
    await writePackageJson({ scripts: { build: "node -e \"console.log('built')\"" } })
    await writeFile(join(workspace.root, 'pnpm-lock.yaml'), '')

    const result = (await handler({ kind: 'build', workspace_root: workspace.root })) as Record<
      string,
      unknown
    >

    expect(result.command).toEqual(['pnpm', 'run', 'build'])
    expect(result.ok).toBe(true)
  })
})
