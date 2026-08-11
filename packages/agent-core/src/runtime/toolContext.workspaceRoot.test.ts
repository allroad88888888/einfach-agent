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
vi.mock('./workspaceRg', () => ({ rgSearchWorkspace: vi.fn(async (input: unknown) => input) }))
vi.mock('./workspacePatch', () => ({ applyWorkspacePatch: vi.fn(async (input: unknown) => input) }))
vi.mock('./workspaceWrite', () => ({
  writeWorkspaceFile: vi.fn(async (input: { path?: string }) => ({
    ok: true,
    path: input.path ?? '',
    bytesWritten: 0,
    created: true,
    overwritten: false,
    appended: false,
  })),
}))
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

import { rootStore, sessionsAtom } from '../state/rootStore'
import { getSessionStore } from '../state/sessionStore'
import { setRun } from '../state/sessionWriters'
import { buildToolContext } from './toolContext'
import { readWorkspaceFile, listWorkspaceFiles, searchWorkspaceFiles } from './workspaceRead'
import { rgSearchWorkspace } from './workspaceRg'
import { applyWorkspacePatch } from './workspacePatch'
import { writeWorkspaceFile } from './workspaceWrite'
import { getWorkspaceDiff } from './workspaceGit'
import { runWorkspaceTask } from './workspaceTask'
import { runShellCommand } from './shellCommand'
import type { DelegateAgentRuntime } from '../subagents/types'
import { addAlwaysAllowedTool, alwaysAllowedToolsAtom } from '../state/transientAtoms'
import { createCoreInstance, defaultCore } from './core/coreInstance'

afterEach(() => {
  vi.clearAllMocks()
})

// 登记一个 running 会话（可选 workspaceRoot），让 ctx.assertFresh 通过。
function seedSession(
  id: string,
  workspaceRoot?: string,
  toolApprovalMode?: 'confirm' | 'auto',
): void {
  rootStore.setter(sessionsAtom, (prev) => ({
    ...prev,
    [id]: {
      id,
      title: 't',
      settings: { vendor: 'deepseek', model: 'x' },
      createdAt: 0,
      updatedAt: 0,
      workspaceRoot,
      toolApprovalMode,
    },
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
          cacheBasePath: '.webAgent-archive/test',
          archiveBasePath: '.webAgent-archive/test',
          eventLog: '.webAgent-archive/test/events.jsonl',
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

  it('子 agent 最终分发在当前 Core registry 内原子拒绝过期注册版本', async () => {
    const core = createCoreInstance()
    const sessionId = 'child-registration-version'
    core.rootStore.setter(sessionsAtom, {
      [sessionId]: {
        id: sessionId,
        title: 't',
        settings: { vendor: 'deepseek', model: 'x' },
        createdAt: 0,
        updatedAt: 0,
      },
    })
    setRun(sessionId, { runId: 'r', status: 'running' }, core)
    const oldExecute = vi.fn(async () => ({ ok: true as const, data: { version: 'old' } }))
    const newExecute = vi.fn(async () => ({ ok: true as const, data: { version: 'new' } }))
    const tool = (execute: typeof oldExecute) => ({
      name: 'read_file',
      runtime: 'server' as const,
      skill: { description: 'isolated read', content: 'isolated read guide' },
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
      execute,
    })
    core.tools.register(tool(oldExecute))
    const expectedRegistrationVersion = core.tools.registrationVersion('read_file')
    let childResult: unknown
    const delegateRuntime: DelegateAgentRuntime = {
      async delegateAgents(_input, callContext) {
        core.tools.register(tool(newExecute))
        childResult = await callContext.runChildTool?.(
          'read_file',
          { path: 'a.txt' },
          expectedRegistrationVersion,
        )
        return {
          treeId: 'r',
          conversationId: sessionId,
          runId: 'r',
          parentPath: 'root',
          strategy: 'parallel_wait_all',
          status: 'done',
          summary: { total: 0, done: 0, failed: 0, cancelled: 0 },
          cacheBasePath: '.webAgent-archive/test',
          archiveBasePath: '.webAgent-archive/test',
          eventLog: '.webAgent-archive/test/events.jsonl',
          skillFiles: [],
          skillIds: [],
          children: [],
        }
      },
    }
    const ctx = buildToolContext({
      sessionId,
      runId: 'r',
      signal: new AbortController().signal,
      callId: 'delegate-version',
      toolName: 'delegate_agent',
      delegateRuntime,
      core,
    })

    await ctx.delegateAgents!({ children: [{ objective: 'inspect' }] })

    expect(childResult).toEqual({
      ok: false,
      error:
        'tool registration version mismatch: read_file ' +
        `(expected ${expectedRegistrationVersion}, current ${core.tools.registrationVersion('read_file')})`,
    })
    expect(oldExecute).not.toHaveBeenCalled()
    expect(newExecute).not.toHaveBeenCalled()
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
          cacheBasePath: '.webAgent-archive/test', archiveBasePath: '.webAgent-archive/test',
          eventLog: '.webAgent-archive/test/events.jsonl', skillFiles: [], skillIds: [], children: [],
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

  it('即使 session 授权状态被污染，也不为 MCP confirmedTools 签发 capability 或执行子调用', async () => {
    const mcpTool = 'mcp__playwright__browser_navigate'
    seedSession('child-mcp', '/ws/root')
    getSessionStore('child-mcp').store.setter(alwaysAllowedToolsAtom, [mcpTool])
    let capability: unknown
    let mcpResult: unknown
    const delegateRuntime: DelegateAgentRuntime = {
      async delegateAgents(_input, callContext) {
        capability = callContext.dangerousToolCapability
        mcpResult = await callContext.runChildTool?.(mcpTool, { url: 'https://example.com' })
        return {
          treeId: 'r', conversationId: 'child-mcp', runId: 'r', parentPath: 'root',
          strategy: 'parallel_wait_all', status: 'done',
          summary: { total: 0, done: 0, failed: 0, cancelled: 0 },
          cacheBasePath: '.webAgent-archive/test', archiveBasePath: '.webAgent-archive/test',
          eventLog: '.webAgent-archive/test/events.jsonl', skillFiles: [], skillIds: [], children: [],
        }
      },
    }
    const ctx = buildToolContext({
      sessionId: 'child-mcp', runId: 'r', signal: new AbortController().signal,
      callId: 'delegate-mcp', toolName: 'delegate_agent',
      toolArgs: { children: [{ objective: 'browse' }], confirmedTools: [mcpTool] },
      agentPath: 'root', delegateRuntime,
    })

    await ctx.delegateAgents!({
      children: [{ objective: 'browse' }],
      confirmedTools: [mcpTool],
    })

    expect(capability).toBeUndefined()
    expect(mcpResult).toEqual({
      ok: false,
      error: `tool not allowed for child agent: ${mcpTool}`,
    })
  })

  it('会话已绑定 workspaceRoot：读/列/搜/rg/patch/写/git/task 各桥入参都带上它', async () => {
    seedSession('s1', '/ws/root')
    const ctx = ctxFor('s1')

    await ctx.readWorkspaceFile!({ path: 'a.txt' })
    await ctx.listWorkspaceFiles!({ path: '.' })
    await ctx.searchWorkspaceFiles!({ query: 'x' })
    await ctx.rgSearchWorkspace!({ query: 'x' })
    await ctx.applyWorkspacePatch!({ operations: [] })
    await ctx.writeWorkspaceFile!({ path: 'a.txt', content: 'y' })
    await ctx.getWorkspaceDiff!({})
    await ctx.runWorkspaceTask!({ kind: 'test' })
    await ctx.runShell({ platform: 'macos', command: 'pwd' })

    expect(vi.mocked(readWorkspaceFile).mock.calls[0][0]).toMatchObject({ path: 'a.txt', workspaceRoot: '/ws/root' })
    expect(vi.mocked(listWorkspaceFiles).mock.calls[0][0]).toMatchObject({ workspaceRoot: '/ws/root' })
    expect(vi.mocked(searchWorkspaceFiles).mock.calls[0][0]).toMatchObject({ workspaceRoot: '/ws/root' })
    expect(vi.mocked(rgSearchWorkspace).mock.calls[0][0]).toMatchObject({ workspaceRoot: '/ws/root' })
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

  it('Auto 从会话状态为四个只读桥注入外部路径权限', async () => {
    seedSession('s-auto', '/session/root', 'auto')
    const ctx = ctxFor('s-auto')

    await ctx.readWorkspaceFile!({ path: '/other/a.txt' })
    await ctx.listWorkspaceFiles!({ path: '../other' })
    await ctx.searchWorkspaceFiles!({ query: 'needle', path: '/other' })
    await ctx.rgSearchWorkspace!({ query: 'needle', path: '/other' })

    for (const call of [
      vi.mocked(readWorkspaceFile).mock.calls[0][0],
      vi.mocked(listWorkspaceFiles).mock.calls[0][0],
      vi.mocked(searchWorkspaceFiles).mock.calls[0][0],
      vi.mocked(rgSearchWorkspace).mock.calls[0][0],
    ]) {
      expect(call).toMatchObject({
        workspaceRoot: '/session/root',
        allowExternalPaths: true,
      })
    }
  })

  it('confirm 移除调用方伪造的外部路径权限，写桥也不会获得该权限', async () => {
    seedSession('s-confirm', '/session/root', 'confirm')
    const ctx = ctxFor('s-confirm')

    await ctx.readWorkspaceFile!({
      path: '/other/a.txt',
      allowExternalPaths: true,
    })
    await ctx.writeWorkspaceFile!({
      path: '/other/a.txt',
      content: 'no',
      allowExternalPaths: true,
    })

    expect(vi.mocked(readWorkspaceFile).mock.calls[0][0]).not.toHaveProperty('allowExternalPaths')
    expect(vi.mocked(writeWorkspaceFile).mock.calls[0][0]).not.toHaveProperty('allowExternalPaths')
  })

  it('shell 调用方已显式带 cwd：尊重调用方 cwd，不被会话 root 覆盖', async () => {
    seedSession('s5', '/session/root')
    await ctxFor('s5').runShell({ platform: 'macos', command: 'pwd', cwd: '  /caller/root  ' })
    expect(vi.mocked(runShellCommand).mock.calls[0][0]).toMatchObject({ cwd: '/caller/root' })
  })
})

// workspace_verify 档位的宿主侧闸门。
// ---------------------------------------------------------------------------
// run_verification_command 仅经子 agent 工具桥暴露；主循环没有 workspace_verify 档位。
describe('toolContext 验证命令执行（workspace_verify）', () => {
  function delegateRuntimeCapturing(
    run: (callContext: DelegateAgentRuntimeCallContext) => Promise<void>,
    sessionId: string,
  ): DelegateAgentRuntime {
    return {
      async delegateAgents(_input, callContext) {
        await run(callContext)
        return {
          treeId: 'r',
          conversationId: sessionId,
          runId: 'r',
          parentPath: 'root',
          strategy: 'parallel_wait_all',
          status: 'done',
          summary: { total: 0, done: 0, failed: 0, cancelled: 0 },
          cacheBasePath: '.webAgent-archive/test',
          archiveBasePath: '.webAgent-archive/test',
          eventLog: '.webAgent-archive/test/events.jsonl',
          skillFiles: [],
          skillIds: [],
          children: [],
        }
      },
    }
  }

  type DelegateAgentRuntimeCallContext = Parameters<DelegateAgentRuntime['delegateAgents']>[1]

  it('workspace_verify 子 agent 可执行验收所需的 shell 命令', async () => {
    seedSession('verify-allowed', '/ws/root')
    let allowed: unknown
    let additionalCommand: unknown
    const ctx = buildToolContext({
      sessionId: 'verify-allowed',
      runId: 'r',
      signal: new AbortController().signal,
      callId: 'c',
      toolName: 'submit_stage_result',
      delegateRuntime: delegateRuntimeCapturing(async (callContext) => {
        allowed = await callContext.runChildTool?.('run_verification_command', { command: 'pnpm test' })
        additionalCommand = await callContext.runChildTool?.('run_verification_command', { command: 'pnpm test --bail' })
      }, 'verify-allowed'),
    })

    await ctx.delegateAgents!({
      children: [{ objective: 'verify' }],
      toolProfile: 'workspace_verify',
    })

    expect(allowed).toMatchObject({ ok: true })
    expect(additionalCommand).toMatchObject({ ok: true })
    expect(vi.mocked(runShellCommand)).toHaveBeenCalledTimes(2)
    expect(vi.mocked(runShellCommand).mock.calls[0][0]).toMatchObject({
      command: 'pnpm test',
      cwd: '/ws/root',
    })
  })

  it('workspace_read 子 agent 无法使用验证工具', async () => {
    seedSession('verify-missing', '/ws/root')
    let result: unknown
    const ctx = buildToolContext({
      sessionId: 'verify-missing',
      runId: 'r',
      signal: new AbortController().signal,
      callId: 'c',
      toolName: 'delegate_agent',
      delegateRuntime: delegateRuntimeCapturing(async (callContext) => {
        result = await callContext.runChildTool?.('run_verification_command', { command: 'pnpm test' })
      }, 'verify-missing'),
    })

    await ctx.delegateAgents!({
      children: [{ objective: 'read' }],
      toolProfile: 'workspace_read',
    })

    expect(result).toEqual({ ok: false, error: 'tool not allowed for child agent: run_verification_command' })
    expect(vi.mocked(runShellCommand)).not.toHaveBeenCalled()
  })

  it('直接执行验证工具时不受命令白名单限制', async () => {
    seedSession('verify-main-agent', '/ws/root')
    const ctx = buildToolContext({
      sessionId: 'verify-main-agent',
      runId: 'r',
      signal: new AbortController().signal,
      callId: 'c',
      toolName: 'run_verification_command',
    })

    const result = await defaultCore.tools.run('run_verification_command', { command: 'pnpm test' }, ctx)

    expect(result).toMatchObject({ ok: true })
    expect(vi.mocked(runShellCommand)).toHaveBeenCalledOnce()
  })
})
