// apps/cli/src/runtime.test.ts —— CLI 装配到底有没有把命令桥接上（N8 判据 2–4）
// ---------------------------------------------------------------------------
// 这里断言的不是「configureHostInvoke 被调用过」，而是**桥背后真的有东西**：core 的
// runtime 模块问出去，Node 侧答回来。理由是这张卡要补的缺口恰恰是「看起来装配了、实际
// 早退了」——CLI 在 H 线之前 isTauriHost() 恒为 false，13 个 runtime 模块一律早退，而
// 装配代码本身没有任何异常。只有「同一个调用在装配前后给出两句不同的话」才证得了这件事。
//
// 【为什么深导入 runtime/shellCommand 与 runtime/workspaceRead】
// `hasHostBridge` / `loadHostInvoke` 刻意不在 `@web-agent/core` 的公开面上（barrel 注释：
// 消费方全在 core 内部），所以宿主侧断言不到那个布尔量本身。这两个模块正是**守卫所在的那一层**：
//   · 没有桥 → `'…：当前宿主未提供命令桥'`（早退分支，本卡之前 CLI 的常态）
//   · 有桥、域没落地 → `'Node 宿主尚未实现命令「…」'`（路由表的明确失败）
// 后一句只可能由本进程的路由表产出，因此它同时证明了 hasHostBridge() 为真（判据 2）与
// 「报的不是缺桥」（判据 4）。check-boundaries 的公开面白名单不扫 `.test.ts`，这条深导入
// 是测试脚手架语义，不构成新的生产依赖面。

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { configureHostInvoke } from '@web-agent/core'
import { runShellCommand } from '@web-agent/core/runtime/shellCommand'
import { resolveUserSkillsRoot } from '@web-agent/core/runtime/userSkillsRoot'
import { readWorkspaceFile } from '@web-agent/core/runtime/workspaceRead'
import { assembleCliRuntime } from './runtime'

/** 与 host-node 的 currentPlatform() 同一张映射：平台不符时命令会在起 shell 之前就停住。 */
const platform =
  process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'

const credentials = { modelCredentials: {}, modelBaseUrls: {}, configPath: '/dev/null' }

let workspaceRoot: string | undefined

async function assemble(): Promise<string> {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'web-agent-cli-runtime-'))
  await assembleCliRuntime({ credentials, verbose: false, workspaceRoot })
  return workspaceRoot
}

afterEach(async () => {
  // 桥是模块级单例：本文件登记的是**真**的进程内桥，不还原会让同 worker 里后续用例
  // 意外拥有本机能力（跑真命令、写真文件），失败时还查不出是谁给的。
  configureHostInvoke(undefined)
  if (workspaceRoot) await rm(workspaceRoot, { recursive: true, force: true })
  workspaceRoot = undefined
})

describe('assembleCliRuntime 的命令桥', () => {
  it('装配前 core 只会答「未提供命令桥」，装配后 run_shell_command 真的执行', async () => {
    // 装配前：这就是 CLI 一直以来的样子——不是执行失败，是压根没有通路。
    const beforeAssembly = await runShellCommand({ platform, command: 'echo bridge' })
    expect(beforeAssembly.stderr).toContain('当前宿主未提供命令桥')
    expect(beforeAssembly.shell).toBe('unavailable')

    const root = await assemble()

    const result = await runShellCommand({
      platform,
      command: 'echo bridge-ok > marker.txt',
      cwd: root,
      timeoutMs: 20_000,
    })

    // exitCode 0 不足以证明「真的执行了」——normalize 的兜底路径也能凑出一个体面的结果对象。
    // 所以命令留一个**只有真子进程才做得出的痕迹**：在 cwd 里落一个文件，再用 node 读回来。
    // 这同时证了 cwd 被送到了对的地方。
    expect(result.exitCode).toBe(0)
    expect(result.shell).not.toBe('unavailable')
    expect(result.stderr).not.toContain('当前宿主未提供命令桥')
    expect((await readFile(join(root, 'marker.txt'), 'utf8')).trim()).toBe('bridge-ok')
  }, 30_000)

  it('尚未落地的 workspace 域报「Node 宿主尚未实现」，而不是「当前宿主未提供命令桥」', async () => {
    const root = await assemble()

    const result = await readWorkspaceFile({ path: 'anything.txt', workspaceRoot: root })

    // 两句话的区别正是这张卡的价值：桥接上了，只是 read/write/patch/change/delete/pathOps
    // 六个域还归 W 线。真接反了（桥没登记）时第一条 expect 会挂在这句上。
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('Node 宿主尚未实现命令「read_workspace_file」')
    expect(result.error).not.toContain('当前宿主未提供命令桥')
  })

  it('主目录经 homeDir 槽位注入：桥答的 get_user_home_dir 就是 CLI 解析的那一个', async () => {
    await assemble()

    // 装配层把 homedir() 解析出的值注入槽位，桥据此答 get_user_home_dir；core 的
    // resolveUserSkillsRoot 走的正是这条命令。两边同一个值 = 进程内只有一个主目录权威
    // （而不是 CLI 一个、桥自己再 os.homedir() 一个）。
    const home = homedir().trim()
    const expected = home.length > 1 ? home.replace(/[/\\]+$/, '') : home

    expect(await resolveUserSkillsRoot()).toBe(expected)
  })
})
