// hostPlatform 的 colocated 测试（S5）。钉的是一件事：**平台由宿主说了算，且两个消费者读到
// 的是同一个值**。
// ---------------------------------------------------------------------------
// 本文件的主场景是「用户在 macOS 的浏览器里，服务端是 Linux」——那台 Linux 服务端在这里弄不出
// 来，所以场景由两半构造：让本地探测答 macos（改 navigator.userAgent），让宿主声明 linux
// （configureHostInvoke 的 platform），再断言两个消费者拿到的都是 linux。
//
// 【为什么假宿主要自己抄一遍 platform mismatch】
// 真正的校验住在两个宿主里（`apps/desktop/src/shell_pipeline.rs` 与
// `packages/host-node/src/shell/pipeline.ts`），而 core 不许依赖它们中的任何一个（依赖方向
// agent-ai ← agent-core ← 能力包 ← app）。所以这里的假 invoke 逐字照抄那一条判据与文案：
// 它同时钉住两件事——按宿主声明组的命令**过得去**，按别的平台组的命令**仍然被挡**。后者是本卡
// 的另一半判据：那条校验挡的是真问题，S5 不许为了让 server 跑通而把它删掉。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { workspacesAtom } from '../state/rootStore'
import type { SessionMeta } from '../state/core.type'
import type { ShellPlatform } from '../tools/types'
import { createCoreInstance } from './core/coreInstance'
import { configureHostInvoke, type HostInvoke } from './hostBridge'
import { detectLocalPlatform, hostPlatform, type HostPlatform } from './hostPlatform'
import { buildStableModelPrefix } from './modelTurnPrefix'
import { runShellCommand } from './shellCommand'

const MAC_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36'

/**
 * 把「跑 core 的这台机器」伪装成某种浏览器。
 *
 * jsdom 的 `userAgent` 是 `Navigator.prototype` 上的 getter，且它的默认值里带着**跑测试的机器**
 * 的 `process.platform`（本机 darwin → 'macos'，CI 的 Linux runner → 'linux'）。不显式桩住的话，
 * 「宿主说 linux」这条断言在 Linux runner 上会恰好也成立，本文件的主场景当场失效。这里在实例上
 * 盖一个自有属性，afterEach 删掉即回到原型上的原实现。
 */
function stubUserAgent(value: string): void {
  Object.defineProperty(navigator, 'userAgent', { value, configurable: true })
}

/**
 * 一个只认得某一个平台的假宿主。判据与文案逐字照抄 host-node 的 `shell/pipeline.ts`
 * （Rust 侧同句），返回的是一次**正常结果**而不是异常——那两个宿主都把准备阶段的失败整形成
 * `exit_code: 1` + stderr 写原因，模型据此知道命令没跑成以及为什么。
 */
function fakeHostRunningOn(current: string): HostInvoke {
  return (async (_cmd: string, args?: Record<string, unknown>) => {
    const requested = args?.platform
    if (requested !== current) {
      return {
        platform: requested,
        shell: 'unavailable',
        command: args?.command,
        cwd: '',
        exit_code: 1,
        stdout: '',
        stderr: `platform mismatch: requested \`${String(requested)}\`, current \`${current}\``,
        duration_ms: 0,
        timed_out: false,
        truncated: false,
      }
    }
    return {
      platform: requested,
      shell: '/bin/bash -lc',
      command: args?.command,
      cwd: '/srv/workspace',
      exit_code: 0,
      stdout: 'ok\n',
      stderr: '',
      duration_ms: 1,
      timed_out: false,
      truncated: false,
    }
  }) as HostInvoke
}

/** 按「宿主跑在 `current` 上」登记一座桥：声明的平台与它真正认得的平台是同一个。 */
function registerHostOn(current: HostPlatform): void {
  configureHostInvoke({ loader: () => Promise.resolve(fakeHostRunningOn(current)), platform: current })
}

/**
 * 消费者①（shell 桥）在真实调用点上的收窄：`run_verification_command` 见到 `'unsupported'` 就
 * 早退，剩下三值才发给桥。这里照同一条路走，免得用一个 `as` 把类型问题掩盖成测试脚手架细节。
 */
function shellPlatform(): ShellPlatform {
  const platform = hostPlatform()
  if (platform === 'unsupported') throw new Error('本用例的宿主不该是 unsupported')
  return platform
}

function session(workspaceId?: string): SessionMeta {
  return {
    id: 'platform-session',
    title: '平台测试',
    settings: { vendor: 'deepseek', model: 'deepseek-v4-flash' },
    createdAt: 0,
    updatedAt: 0,
    ...(workspaceId ? { workspaceId } : {}),
  }
}

/** 注入给模型的「运行环境」段——两个消费者里的那个②。 */
async function environmentText(): Promise<string> {
  const core = createCoreInstance()
  core.rootStore.setter(workspacesAtom, {
    workspace: { id: 'workspace', name: '工作区', rootPath: '/srv/workspace', createdAt: 0, updatedAt: 0 },
  })
  const prefix = await buildStableModelPrefix(session('workspace'), core)
  return prefix.environment.content
}

beforeEach(() => {
  configureHostInvoke(undefined)
  stubUserAgent(MAC_USER_AGENT)
})

afterEach(() => {
  configureHostInvoke(undefined)
  delete (navigator as unknown as Record<string, unknown>).userAgent
})

describe('没有桥时', () => {
  it('回落本地探测——此刻没有第二个权威可与之矛盾', () => {
    expect(hostPlatform()).toBe('macos')
    expect(hostPlatform()).toBe(detectLocalPlatform())
  })

  it('本地探测认 UA：三种系统各答各的', () => {
    stubUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
    expect(detectLocalPlatform()).toBe('windows')
    stubUserAgent('Mozilla/5.0 (X11; Linux x86_64)')
    expect(detectLocalPlatform()).toBe('linux')
  })
})

describe('macOS 浏览器 + Linux 服务端（S5 的主场景）', () => {
  it('两个消费者都拿到宿主声明的 linux，而不是本地探测的 macos', async () => {
    registerHostOn('linux')

    // 本地探测仍然答 macos——场景成立的前提，也证明下面两条不是恰好同值。
    expect(detectLocalPlatform()).toBe('macos')
    expect(hostPlatform()).toBe('linux')

    // 消费者②：注入给模型的「运行环境」段。模型据这一行在三个 shell 工具里挑一个。
    const environment = await environmentText()
    expect(environment).toContain('本机平台 linux')
    expect(environment).not.toContain('macos')

    // 消费者①：shell 桥的 platform 入参。宿主收到后与自己比对——通过即证明「组命令」和
    // 「执行命令」用的是同一个事实。
    const result = await runShellCommand({ platform: shellPlatform(), command: 'echo ok' })
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toBe('ok\n')
  })

  it('改回本地探测就会两边打架——这条钉的是上一条不是恒真', async () => {
    registerHostOn('linux')

    // 若哪天有人把消费者换回 detectLocalPlatform()，命令就长这样，而它必然被宿主拒绝。
    const result = await runShellCommand({ platform: detectLocalPlatform(), command: 'echo ok' })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toBe('platform mismatch: requested `macos`, current `linux`')
  })
})

describe('「模型按错平台组命令」仍然被挡住', () => {
  it('宿主是 linux 时，硬编码 macos 的 shell 工具照样撞 platform mismatch', async () => {
    registerHostOn('linux')

    // shell_macos / shell_powershell 这类工具的 platform 是**写死**的（模型挑哪个工具就等于
    // 声明哪个平台）。S5 换的只是「运行环境段告诉模型哪个平台」，不是把校验拆掉。
    const result = await runShellCommand({ platform: 'macos', command: 'sw_vers' })
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('platform mismatch')
  })
})

describe('平台与桥同生共死', () => {
  it('重置桥会一并清空平台，不会停在上一任宿主的值', () => {
    registerHostOn('windows')
    expect(hostPlatform()).toBe('windows')

    configureHostInvoke(undefined)

    // 停在 windows 的话，浏览器预览会对模型宣称自己在 Windows 上——而且不报错。
    expect(hostPlatform()).toBe('macos')
  })

  it('换桥即换平台', () => {
    registerHostOn('linux')
    registerHostOn('windows')
    expect(hostPlatform()).toBe('windows')
  })
})

describe('宿主平台不在三种 shell 之内时', () => {
  it('如实声明 unsupported，并明确告诉模型别调 shell 工具', async () => {
    registerHostOn('unsupported')

    expect(hostPlatform()).toBe('unsupported')
    const environment = await environmentText()
    expect(environment).toContain('本机平台 unsupported')
    expect(environment).toContain('shell 类工具在本宿主上一定失败')
  })
})
