// S4-A toolContext 透传 workspaceRoot 的单测。
// ---------------------------------------------------------------------------
// 把 workspace 桥整模块 mock 成「回显入参」的 spy，断言 ctx 的对应方法调用桥时，
// 把该会话 SessionMeta.workspaceRoot 作为入参带上；未绑定则不带（Rust 走 git root 兜底）；
// 调用方已显式带 root 则尊重调用方。独立文件 mock 桥，不影响 toolContext.test.ts（那边跑真桥）。
// workspace_verify 档位的宿主侧闸门测试拆在同目录的 toolContext.verifyProfile.test.ts（A2b）；
// 两个文件共享的 seedSession / runDelegation helper 住 toolContext.workspaceRoot.testHarness.ts。

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

import { getSessionStore } from '../state/sessionStore'
import { buildToolContext } from './toolContext'
import { readWorkspaceFile, listWorkspaceFiles, searchWorkspaceFiles } from './workspaceRead'
import { rgSearchWorkspace } from './workspaceRg'
import { applyWorkspacePatch } from './workspacePatch'
import { writeWorkspaceFile } from './workspaceWrite'
import { getWorkspaceDiff } from './workspaceGit'
import { runWorkspaceTask } from './workspaceTask'
import { runShellCommand } from './shellCommand'
import { addAlwaysAllowedTool, alwaysAllowedToolsAtom } from '../state/transientAtoms'
import { createCoreInstance } from './core/coreInstance'
import { delegateRuntimeCapturing, seedSession, runDelegation } from './toolContext.workspaceRoot.testHarness'

afterEach(() => {
  vi.clearAllMocks()
})

function ctxFor(id: string) {
  return buildToolContext({ sessionId: id, runId: 'r', signal: new AbortController().signal, callId: 'c', toolName: 'x' })
}

describe('toolContext workspaceRoot 透传（S4-A）', () => {
  it('子 agent 只读工具走完整 ToolContext，且宿主再次拒绝写工具', async () => {
    seedSession('child-tools', '/ws/root')
    let readResult: unknown
    let writeResult: unknown
    const delegateRuntime = delegateRuntimeCapturing(async (callContext) => {
      readResult = await callContext.runChildTool?.('read_file', { path: 'a.txt' })
      writeResult = await callContext.runChildTool?.('write_file', { path: 'a.txt', content: 'no' })
    }, 'child-tools')
    const ctx = buildToolContext({
      sessionId: 'child-tools', runId: 'r', signal: new AbortController().signal,
      callId: 'c', toolName: 'delegate_agent', delegateRuntime,
    })

    await runDelegation(ctx, { children: [{ objective: 'inspect' }] })

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
    seedSession(sessionId, undefined, undefined, core)
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
    const delegateRuntime = delegateRuntimeCapturing(async (callContext) => {
      core.tools.register(tool(newExecute))
      childResult = await callContext.runChildTool?.(
        'read_file',
        { path: 'a.txt' },
        expectedRegistrationVersion,
      )
    }, sessionId)
    const ctx = buildToolContext({
      sessionId, runId: 'r', signal: new AbortController().signal,
      callId: 'delegate-version', toolName: 'delegate_agent', delegateRuntime, core,
    })

    await runDelegation(ctx, { children: [{ objective: 'inspect' }] })

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
    const delegateRuntime = delegateRuntimeCapturing(async (callContext) => {
      capability = callContext.dangerousToolCapability
      writeResult = await callContext.runChildTool?.('write_file', { path: 'a.txt', content: 'yes' })
      patchResult = await callContext.runChildTool?.('apply_patch', { operations: [] })
    }, 'child-confirmed')
    const ctx = buildToolContext({
      sessionId: 'child-confirmed', runId: 'r', signal: new AbortController().signal,
      callId: 'delegate-call', toolName: 'delegate_agent',
      toolArgs: { children: [{ objective: 'write' }], confirmedTools: ['write_file'] },
      agentPath: 'root', delegateRuntime,
    })

    await runDelegation(ctx, { children: [{ objective: 'write' }], confirmedTools: ['write_file'] })

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
    const delegateRuntime = delegateRuntimeCapturing(async (callContext) => {
      capability = callContext.dangerousToolCapability
      mcpResult = await callContext.runChildTool?.(mcpTool, { url: 'https://example.com' })
    }, 'child-mcp')
    const ctx = buildToolContext({
      sessionId: 'child-mcp', runId: 'r', signal: new AbortController().signal,
      callId: 'delegate-mcp', toolName: 'delegate_agent',
      toolArgs: { children: [{ objective: 'browse' }], confirmedTools: [mcpTool] },
      agentPath: 'root', delegateRuntime,
    })

    await runDelegation(ctx, {
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
