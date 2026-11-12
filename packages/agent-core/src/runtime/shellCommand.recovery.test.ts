import { beforeEach, expect, it, vi } from 'vitest'
import { hostBridgeMock } from './hostBridgeMock.testHarness'
import { createCoreInstance } from './core/coreInstance'
import { getExecutionRuntime } from '../execution/runtime'
import { captureRecoverySnapshot } from '../state/recoveryProjection'
import { recoverySession, sessionId } from '../state/recoveryProjection.fixtures'
import { sessionsAtom } from '../state/rootAtoms'
import { shellCommandToolResult } from '../../../../tools/shell/src/command-result'
import { runShellCommand } from './shellCommand'

const host = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('./hostBridge', () => hostBridgeMock(async () => host.invoke))
beforeEach(() => vi.clearAllMocks())

it.each([
  { exit_code: 0, timed_out: false },
  { exit_code: 1, timed_out: false },
  { exit_code: -1, timed_out: true },
  { exit_code: -1, timed_out: true, timeout_reason: 'idle' },
  { exit_code: -1, timed_out: true, timeout_reason: 'total' },
  { exit_code: -1, timed_out: true, timeout_reason: 'unknown' },
])('can capture recovery after shell result %j', async (outcome) => {
  host.invoke.mockResolvedValue({
    shell: '/bin/zsh', cwd: '/tmp', stdout: '', stderr: '', duration_ms: 1,
    truncated: false, ...outcome,
  })
  const core = createCoreInstance()
  core.rootStore.setter(sessionsAtom, { [sessionId]: recoverySession })
  const result = await getExecutionRuntime(core).run({
    id: 'shell-call', graphId: 'run', sessionId, runId: 'run', type: 'tool',
    label: 'shell_macos',
    task: async () => shellCommandToolResult(await runShellCommand({ platform: 'macos', command: 'test' })),
  })
  const snapshot = captureRecoverySnapshot(core.getSessionStore(sessionId).store, {
    rootStore: core.rootStore, sessionId, generation: 1,
  })
  expect(snapshot.values.executionGraph.nodes['shell-call'].result).toEqual(result)
  expect(JSON.parse(JSON.stringify(result))).toEqual(result)
})
