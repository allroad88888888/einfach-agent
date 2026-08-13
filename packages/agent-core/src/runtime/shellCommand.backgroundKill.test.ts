import { beforeEach, describe, expect, it, vi } from 'vitest'

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
}))

vi.mock('@tauri-apps/api/core', () => tauri)

// D5：shellCommand 改用 ./hostTauri 之后，宿主判定读的是 globalThis.isTauri、invoke 走惰性动态
// import，两者都不再经过上面那份模块 mock。这里把 hostTauri 一并 mock 掉：isTauriHost 恒真、
// loadTauriInvoke 仍然吐同一个 tauri.invoke，既有用例的断言一字不动照旧成立。
vi.mock('./hostTauri', () => ({
  isTauriHost: () => true,
  loadTauriInvoke: async () => tauri.invoke,
}))

import { runShellCommand } from './shellCommand'

const input = { platform: 'macos', command: 'echo hi' } as const

function backendResult(overrides: Record<string, unknown> = {}) {
  return {
    platform: 'macos',
    shell: '/bin/zsh -lc',
    command: 'echo hi',
    cwd: '/tmp',
    exit_code: 0,
    stdout: 'hi',
    stderr: '',
    duration_ms: 1,
    timed_out: false,
    truncated: false,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  tauri.isTauri.mockReturnValue(true)
})

describe('runShellCommand backgroundProcessesKilled', () => {
  it('把后端 snake_case background_processes_killed 归一化为 camelCase', async () => {
    tauri.invoke.mockResolvedValue(backendResult({ background_processes_killed: true }))

    const result = await runShellCommand({ ...input })

    expect(result.backgroundProcessesKilled).toBe(true)
  })

  it('后端未报告该字段时归一化为 false，不留 undefined', async () => {
    tauri.invoke.mockResolvedValue(backendResult())

    const result = await runShellCommand({ ...input })

    expect(result.backgroundProcessesKilled).toBe(false)
  })
})
