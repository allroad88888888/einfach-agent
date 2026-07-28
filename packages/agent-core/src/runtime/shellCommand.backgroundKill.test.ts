import { beforeEach, describe, expect, it, vi } from 'vitest'

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
}))

vi.mock('@tauri-apps/api/core', () => tauri)

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
