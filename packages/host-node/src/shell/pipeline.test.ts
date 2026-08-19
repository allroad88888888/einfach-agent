// 真 spawn 子进程的集成测试：不 mock，真的起 shell 跑 echo/pwd/sleep。
// 对齐 apps/desktop/src/shell_pipeline_tests.rs（已随 T1 删除）的五个用例，再补三条 Rust 侧没有断言、
// 但 Node 侧最容易写错的（输出上限下子进程仍能正常退出、env 是合并不是替换、
// 准备阶段失败时各字段回显到哪一步）。
import { mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { executeShellCommand } from './pipeline'
import { currentPlatform } from './platform'

const host = currentPlatform()
const isWindows = process.platform === 'win32'
// 单条命令要起一个 login shell（`-lc`），用户的 profile 可能不快，给足余量。
const SPAWN_BUDGET_MS = 20_000

let tempDir: string

beforeEach(async () => {
  // canonicalize：macOS 的 /var 是指向 /private/var 的软链，不解开的话每条 cwd 断言都会
  // 因为这个与被测逻辑无关的理由失败。
  tempDir = await realpath(await mkdtemp(join(tmpdir(), 'host-node-shell-')))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

describe('executeShellCommand（真子进程）', () => {
  it(
    '捕获 stdout 与退出码',
    async () => {
      const result = await executeShellCommand({ platform: host, command: 'echo hello' })

      expect(result.stdout).toContain('hello')
      expect(result.exit_code).toBe(0)
      expect(result.timed_out).toBe(false)
      expect(result.truncated).toBe(false)
      expect(result.background_processes_killed).toBe(false)
      expect(result.platform).toBe(host)
    },
    SPAWN_BUDGET_MS,
  )

  it(
    '非零退出码原样回传',
    async () => {
      const result = await executeShellCommand({ platform: host, command: 'exit 3' })

      expect(result.exit_code).toBe(3)
      expect(result.timed_out).toBe(false)
    },
    SPAWN_BUDGET_MS,
  )

  it(
    'cwd 生效，且结果回显 canonicalize 之后的路径',
    async () => {
      const command = isWindows ? 'Get-Location | ForEach-Object { $_.Path }' : 'pwd'

      const result = await executeShellCommand({ platform: host, command, cwd: tempDir })

      expect(result.exit_code).toBe(0)
      expect(result.cwd).toBe(tempDir)
      expect(result.stdout).toContain(tempDir)
    },
    SPAWN_BUDGET_MS,
  )

  it(
    '超时真的杀掉进程，不是等它自己结束',
    async () => {
      const command = isWindows ? 'Start-Sleep -Seconds 5' : 'sleep 5'
      const startedAt = Date.now()

      const result = await executeShellCommand({ platform: host, command, timeoutMs: 200 })

      expect(result.timed_out).toBe(true)
      expect(Date.now() - startedAt).toBeLessThan(3_000)
      // 被信号杀死的进程没有退出码。core 侧会把 null 整形成 exitCode: -1 并在 stderr 补一句，
      // 那是桌面端今天就有的语义，不是本移植的选择。
      if (!isWindows) expect(result.exit_code).toBeNull()
    },
    SPAWN_BUDGET_MS,
  )

  it(
    '正常命令不报告清理后台进程',
    async () => {
      // 这个 flag 同时也是「没有白等一轮 drain grace」的证据：它只在两条流都在 grace 到点
      // **之前**读完时为 false。所以这里不再叠一条会随机器快慢晃动的耗时断言。
      const result = await executeShellCommand({ platform: host, command: 'echo done' })

      expect(result.background_processes_killed).toBe(false)
    },
    SPAWN_BUDGET_MS,
  )

  it(
    '输出远超上限时子进程仍能正常退出（截断走的是 drain，不是停读）',
    async () => {
      // 100 KB 一次写完，远超管道缓冲（几十 KB）。若读端到上限就不再读，写端会卡在 write 上，
      // 子进程永远走不到退出——症状是这条用例的 exit_code 变成 null、timed_out 变成 true。
      const command = isWindows
        ? "Write-Output ('x' * 100000)"
        : "head -c 100000 /dev/zero | tr '\\0' 'x'"

      const result = await executeShellCommand({
        platform: host,
        command,
        maxOutputChars: 10,
        timeoutMs: 5_000,
      })

      expect(result.exit_code).toBe(0)
      expect(result.timed_out).toBe(false)
      expect(result.truncated).toBe(true)
      expect(result.stdout).toBe('x'.repeat(10))
    },
    SPAWN_BUDGET_MS,
  )

  it(
    '0 与负数被当成「没传」，回落到默认上限而不是当场超时/零输出',
    async () => {
      // Rust 的 `normalize_*` 是 `Some(v) if v > 0`，0 走的是默认值分支。照抄成「传了就用」
      // 的话，timeout=0 会让每条命令一起步就被杀，而这种失败看起来像「命令自己没跑成」。
      const command = isWindows ? 'Start-Sleep -Milliseconds 800' : 'sleep 0.8'

      const result = await executeShellCommand({
        platform: host,
        command,
        timeoutMs: 0,
        maxOutputChars: -1,
      })

      expect(result.timed_out).toBe(false)
      expect(result.exit_code).toBe(0)
    },
    SPAWN_BUDGET_MS,
  )

  it(
    'env 是往继承来的环境里加，不是整份替换',
    async () => {
      // Node 的 `env` 选项语义与 Rust 的 `Command::envs()` 相反，照抄写法会让子进程丢掉整个
      // 父环境。用一个只可能来自父进程的变量作证据。
      process.env.WEB_AGENT_SHELL_INHERITED = 'inherited-value'
      const command = isWindows
        ? 'Write-Output "$env:WEB_AGENT_SHELL_INHERITED/$env:WEB_AGENT_SHELL_INJECTED"'
        : 'echo "$WEB_AGENT_SHELL_INHERITED/$WEB_AGENT_SHELL_INJECTED"'

      try {
        const result = await executeShellCommand({
          platform: host,
          command,
          env: { WEB_AGENT_SHELL_INJECTED: 'injected-value' },
        })

        expect(result.stdout).toContain('inherited-value/injected-value')
      } finally {
        delete process.env.WEB_AGENT_SHELL_INHERITED
      }
    },
    SPAWN_BUDGET_MS,
  )
})

// 进程组语义是 Unix 独有的：Windows 上 Rust 与 Node 都只杀直接子进程，无从断言。
describe.skipIf(isWindows)('后台进程握着管道时不挂死调用', () => {
  it(
    '快速返回、保留已捕获的输出、并把整个进程组杀掉',
    async () => {
      // 回归用例（对应 Rust 侧实测的 96 分钟挂死）：`cmd &` 让孙进程继承 stdout 管道，
      // 父 shell 立刻退出——超时只管直接子进程，所以修复前读端等不到 EOF，整个调用一直挂到
      // 孤儿自己退出为止（`npm run dev` 这种就是永久）。
      //
      // 两个后台进程各证一件事：`sleep 30` 长期握着管道，坏掉时会把调用拖满 30s；
      // 短命的 touch 证明进程组真的被杀了——只要它还活着，1s 后 marker 就会出现。
      const marker = join(tempDir, 'orphan-survived')
      const command = `sleep 30 & (sleep 1 && touch ${marker}) & echo started`
      const startedAt = Date.now()

      const result = await executeShellCommand({ platform: host, command, timeoutMs: 10_000 })

      expect(Date.now() - startedAt).toBeLessThan(SPAWN_BUDGET_MS)
      expect(result.exit_code).toBe(0)
      expect(result.timed_out).toBe(false)
      expect(result.background_processes_killed).toBe(true)
      // 放弃读取之前已经捕获的输出不该丢。
      expect(result.stdout).toContain('started')

      // 跨过孤儿的 1s touch 时点再看：文件不存在才说明进程组真的被杀了。
      await new Promise((resolve) => setTimeout(resolve, 1_500))
      expect(await exists(marker)).toBe(false)
    },
    SPAWN_BUDGET_MS,
  )
})

describe('准备阶段的失败：一次 exit_code 1 的正常结果，字段回显到失败那一步', () => {
  it('平台不认识时回显调用方给的原字符串', async () => {
    const result = await executeShellCommand({ platform: 'plan9', command: 'echo hi' })

    expect(result.exit_code).toBe(1)
    expect(result.platform).toBe('plan9')
    expect(result.shell).toBe('unavailable')
    expect(result.stderr).toBe(
      'unsupported platform `plan9`; expected `macos`, `linux`, or `windows`',
    )
  })

  it('平台合法但与本机不符时明确说出两边', async () => {
    const other = host === 'linux' ? 'macos' : 'linux'

    const result = await executeShellCommand({ platform: other, command: 'echo hi' })

    expect(result.exit_code).toBe(1)
    expect(result.shell).toBe('unavailable')
    expect(result.stderr).toBe(`platform mismatch: requested \`${other}\`, current \`${host}\``)
  })

  it('cwd 不可用时 shell 已选出、cwd 仍回显未解析的原值', async () => {
    const missing = join(tempDir, 'no-such-dir')

    const result = await executeShellCommand({ platform: host, command: 'echo hi', cwd: missing })

    expect(result.exit_code).toBe(1)
    expect(result.cwd).toBe(missing)
    expect(result.shell).not.toBe('unavailable')
    expect(result.stderr).toContain(`cwd \`${missing}\` is not accessible`)
    expect(result.stdout).toBe('')
  })

  it('cwd 是文件而不是目录', async () => {
    const filePath = join(tempDir, 'a-file')
    await writeFile(filePath, 'x')

    const result = await executeShellCommand({ platform: host, command: 'echo hi', cwd: filePath })

    expect(result.stderr).toBe(`cwd \`${filePath}\` is not a directory`)
  })

  it('cwd 是全空白时当作非法，而不是当作没传', async () => {
    const result = await executeShellCommand({ platform: host, command: 'echo hi', cwd: '   ' })

    expect(result.stderr).toBe('cwd cannot be empty')
  })
})
