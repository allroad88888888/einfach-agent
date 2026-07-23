// S4-A toolContext 透传 workspaceRoot 的单测。
// ---------------------------------------------------------------------------
// 把 workspace 桥整模块 mock 成「回显入参」的 spy，断言 ctx 的对应方法调用桥时，
// 把该会话 SessionMeta.workspaceRoot 作为入参带上；未绑定则不带（Rust 走 git root 兜底）；
// 调用方已显式带 root 则尊重调用方。独立文件 mock 桥，不影响 toolContext.test.ts（那边跑真桥）。

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./workspaceRead', () => ({
  readWorkspaceFile: vi.fn(async (input: unknown) => ({ ok: true, data: input })),
  listWorkspaceFiles: vi.fn(async (input: unknown) => ({ ok: true, data: input })),
  searchWorkspaceFiles: vi.fn(async (input: unknown) => ({ ok: true, data: input })),
}))
vi.mock('./workspacePatch', () => ({ applyWorkspacePatch: vi.fn(async (input: unknown) => input) }))
vi.mock('./workspaceWrite', () => ({ writeWorkspaceFile: vi.fn(async (input: unknown) => input) }))
vi.mock('./workspaceGit', () => ({ getWorkspaceDiff: vi.fn(async (input: unknown) => input) }))
vi.mock('./workspaceTask', () => ({ runWorkspaceTask: vi.fn(async (input: unknown) => input) }))
vi.mock('./shellCommand', () => ({
  runShellCommand: vi.fn(async (input: { platform: string; command: string; cwd?: string }) => ({
    platform: input.platform,
    shell: 'test',
    command: input.command,
    cwd: input.cwd ?? '',
    exitCode: 0,
    stdout: '',
    stderr: '',
    durationMs: 0,
    timedOut: false,
    truncated: false,
  })),
}))

import { rootStore, sessionsAtom, resetRootStore } from '../state/rootStore'
import { resetSessionStores } from '../state/sessionStore'
import { setRun } from '../state/sessionWriters'
import { buildToolContext } from './toolContext'
import { readWorkspaceFile, listWorkspaceFiles, searchWorkspaceFiles } from './workspaceRead'
import { applyWorkspacePatch } from './workspacePatch'
import { writeWorkspaceFile } from './workspaceWrite'
import { getWorkspaceDiff } from './workspaceGit'
import { runWorkspaceTask } from './workspaceTask'
import { runShellCommand } from './shellCommand'
import type { DelegateAgentRuntime } from '../subagents/types'
import { addAlwaysAllowedTool } from '../state/transientAtoms'

afterEach(() => {
  resetRootStore()
  resetSessionStores()
  vi.clearAllMocks()
})

// 登记一个 running 会话（可选 workspaceRoot），让 ctx.assertFresh 通过。
function seedSession(id: string, workspaceRoot?: string): void {
  rootStore.setter(sessionsAtom, (prev) => ({
    ...prev,
    [id]: { id, title: 't', settings: { vendor: 'deepseek', model: 'x' }, createdAt: 0, updatedAt: 0, workspaceRoot },
  }))
  setRun(id, { runId: 'r', status: 'running' })
}

function ctxFor(id: string) {
  return buildToolContext({ sessionId: id, runId: 'r', signal: new AbortController().signal, callId: 'c', toolName: 'x' })
}

describe('toolContext workspaceRoot 透传（S4-A）', () => {
  it('子 agent 只读工具走完整 ToolContext，且宿主再次拒绝写工具', async () => {
    seedSession('child-tools', '/ws/root')
    let readResult: unknown
    let writeResult: unknown
    const delegateRuntime: DelegateAgentRuntime = {
      async delegateAgents(_input, callContext) {
        readResult = await callContext.runChildTool?.('read_file', { path: 'a.txt' })
        writeResult = await callContext.runChildTool?.('write_file', { path: 'a.txt', content: 'no' })
        return {
          treeId: 'r',
          conversationId: 'child-tools',
          runId: 'r',
          parentPath: 'root',
          strategy: 'parallel_wait_all',
          status: 'done',
          summary: { total: 0, done: 0, failed: 0, cancelled: 0 },
          cacheBasePath: '.agent-archive/test',
          archiveBasePath: '.agent-archive/test',
          eventLog: '.agent-archive/test/events.jsonl',
          skillFiles: [],
          skillIds: [],
          children: [],
        }
      },
    }
    const ctx = buildToolContext({
      sessionId: 'child-tools',
      runId: 'r',
      signal: new AbortController().signal,
      callId: 'c',
      toolName: 'delegate_agent',
      delegateRuntime,
    })

    await ctx.delegateAgents!({ children: [{ objective: 'inspect' }] })

    expect(readResult).toMatchObject({ ok: true })
    expect(vi.mocked(readWorkspaceFile)).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'a.txt', workspaceRoot: '/ws/root' }),
    )
    expect(writeResult).toEqual({ ok: false, error: 'tool not allowed for child agent: write_file' })
    expect(vi.mocked(writeWorkspaceFile)).not.toHaveBeenCalled()
  })

  it('只为本次显式请求且 session 已确认的危险工具签发范围化 capability', async () => {
    seedSession('child-confirmed', '/ws/root')
    addAlwaysAllowedTool('child-confirmed', 'write_file')
    addAlwaysAllowedTool('child-confirmed', 'apply_patch')
    let capability: unknown
    let writeResult: unknown
    let patchResult: unknown
    const delegateRuntime: DelegateAgentRuntime = {
      async delegateAgents(_input, callContext) {
        capability = callContext.dangerousToolCapability
        writeResult = await callContext.runChildTool?.('write_file', { path: 'a.txt', content: 'yes' })
        patchResult = await callContext.runChildTool?.('apply_patch', { operations: [] })
        return {
          treeId: 'r', conversationId: 'child-confirmed', runId: 'r', parentPath: 'root',
          strategy: 'parallel_wait_all', status: 'done',
          summary: { total: 0, done: 0, failed: 0, cancelled: 0 },
          cacheBasePath: '.agent-archive/test', archiveBasePath: '.agent-archive/test',
          eventLog: '.agent-archive/test/events.jsonl', skillFiles: [], skillIds: [], children: [],
        }
      },
    }
    const ctx = buildToolContext({
      sessionId: 'child-confirmed', runId: 'r', signal: new AbortController().signal,
      callId: 'delegate-call', toolName: 'delegate_agent',
      toolArgs: { children: [{ objective: 'write' }], confirmedTools: ['write_file'] },
      agentPath: 'root', delegateRuntime,
    })

    await ctx.delegateAgents!({ children: [{ objective: 'write' }], confirmedTools: ['write_file'] })

    expect(capability).toEqual({
      sessionId: 'child-confirmed', runId: 'r', delegationCallId: 'delegate-call',
      parentPath: 'root', toolNames: ['write_file'],
    })
    expect(writeResult).toMatchObject({ ok: true })
    expect(patchResult).toEqual({ ok: false, error: 'tool not allowed for child agent: apply_patch' })
    expect(vi.mocked(writeWorkspaceFile)).toHaveBeenCalled()
    expect(vi.mocked(applyWorkspacePatch)).not.toHaveBeenCalled()
  })

  it('会话已绑定 workspaceRoot：读/列/搜/patch/写/git/task 各桥入参都带上它', async () => {
    seedSession('s1', '/ws/root')
    const ctx = ctxFor('s1')

    await ctx.readWorkspaceFile!({ path: 'a.txt' })
    await ctx.listWorkspaceFiles!({ path: '.' })
    await ctx.searchWorkspaceFiles!({ query: 'x' })
    await ctx.applyWorkspacePatch!({ operations: [] })
    await ctx.writeWorkspaceFile!({ path: 'a.txt', content: 'y' })
    await ctx.getWorkspaceDiff!({})
    await ctx.runWorkspaceTask!({ kind: 'test' })
    await ctx.runShell({ platform: 'macos', command: 'pwd' })

    expect(vi.mocked(readWorkspaceFile).mock.calls[0][0]).toMatchObject({ path: 'a.txt', workspaceRoot: '/ws/root' })
    expect(vi.mocked(listWorkspaceFiles).mock.calls[0][0]).toMatchObject({ workspaceRoot: '/ws/root' })
    expect(vi.mocked(searchWorkspaceFiles).mock.calls[0][0]).toMatchObject({ workspaceRoot: '/ws/root' })
    expect(vi.mocked(applyWorkspacePatch).mock.calls[0][0]).toMatchObject({ workspaceRoot: '/ws/root' })
    expect(vi.mocked(writeWorkspaceFile).mock.calls[0][0]).toMatchObject({ workspaceRoot: '/ws/root' })
    expect(vi.mocked(getWorkspaceDiff).mock.calls[0][0]).toMatchObject({ workspaceRoot: '/ws/root' })
    expect(vi.mocked(runWorkspaceTask).mock.calls[0][0]).toMatchObject({ workspaceRoot: '/ws/root' })
    expect(vi.mocked(runShellCommand).mock.calls[0][0]).toMatchObject({ cwd: '/ws/root' })
  })

  it('getWorkspaceDiff 不带 input：合成只含 root 的入参', async () => {
    seedSession('s2', '/ws/root')
    await ctxFor('s2').getWorkspaceDiff!()
    expect(vi.mocked(getWorkspaceDiff).mock.calls[0][0]).toEqual({ workspaceRoot: '/ws/root' })
  })

  it('workspaceRoot 前后空白被 trim 后透传', async () => {
    seedSession('s2b', '  /ws/root  ')
    await ctxFor('s2b').readWorkspaceFile!({ path: 'a.txt' })
    expect(vi.mocked(readWorkspaceFile).mock.calls[0][0]).toMatchObject({ workspaceRoot: '/ws/root' })
    await ctxFor('s2b').runShell({ platform: 'macos', command: 'pwd' })
    expect(vi.mocked(runShellCommand).mock.calls[0][0]).toMatchObject({ cwd: '/ws/root' })
  })

  it('会话未绑定 workspaceRoot：桥入参不带该字段（Rust 走 git root 兜底）', async () => {
    seedSession('s3') // 无 workspaceRoot
    await ctxFor('s3').readWorkspaceFile!({ path: 'a.txt' })
    const input = vi.mocked(readWorkspaceFile).mock.calls[0][0]
    // 无 root → 原样透传，不新增 workspaceRoot 字段。
    expect(input).toEqual({ path: 'a.txt' })
    expect(input.workspaceRoot).toBeUndefined()
    await ctxFor('s3').runShell({ platform: 'macos', command: 'pwd' })
    expect(vi.mocked(runShellCommand).mock.calls[0][0]).toEqual(
      expect.objectContaining({ platform: 'macos', command: 'pwd' }),
    )
    expect(vi.mocked(runShellCommand).mock.calls[0][0].cwd).toBeUndefined()
  })

  it('调用方已显式带 workspaceRoot：尊重调用方、不被会话 root 覆盖', async () => {
    seedSession('s4', '/session/root')
    await ctxFor('s4').readWorkspaceFile!({ path: 'a.txt', workspaceRoot: '/caller/root' })
    expect(vi.mocked(readWorkspaceFile).mock.calls[0][0]).toMatchObject({ workspaceRoot: '/caller/root' })
  })

  it('shell 调用方已显式带 cwd：尊重调用方 cwd，不被会话 root 覆盖', async () => {
    seedSession('s5', '/session/root')
    await ctxFor('s5').runShell({ platform: 'macos', command: 'pwd', cwd: '  /caller/root  ' })
    expect(vi.mocked(runShellCommand).mock.calls[0][0]).toMatchObject({ cwd: '/caller/root' })
  })
})
