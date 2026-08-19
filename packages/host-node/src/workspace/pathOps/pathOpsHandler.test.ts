import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createCopyWorkspacePathHandler,
  createMoveWorkspacePathHandler,
  narrowWorkspacePathOperationArgs,
} from './pathOpsHandler'
import { createTempWorkspace, type TempWorkspace } from '../common/tempWorkspace.testHarness'
import type { WorkspacePathOperationResult } from './result'

let workspace: TempWorkspace

beforeEach(async () => {
  workspace = await createTempWorkspace()
})

afterEach(async () => {
  await workspace.cleanup()
})

describe('narrowWorkspacePathOperationArgs', () => {
  it('顶层键是 snake_case，change_context 的值内部是 camelCase', () => {
    expect(
      narrowWorkspacePathOperationArgs('copy', {
        source: 'a.txt',
        destination: 'b.txt',
        workspace_root: '/tmp/ws',
        change_context: { changeId: 'chg', sessionId: 'sess', runId: 'run', toolCallId: 'call' },
      }),
    ).toEqual({
      source: 'a.txt',
      destination: 'b.txt',
      workspaceRoot: '/tmp/ws',
      changeContext: { changeId: 'chg', sessionId: 'sess', runId: 'run', toolCallId: 'call' },
    })
  })

  it('键存在但值为 undefined / null 一律当没给', () => {
    const narrowed = narrowWorkspacePathOperationArgs('move', {
      source: 'a.txt',
      destination: 'b.txt',
      workspace_root: undefined,
      change_context: null,
    })
    expect(narrowed.workspaceRoot).toBeUndefined()
    expect(narrowed.changeContext).toBeUndefined()
  })

  it.each([
    ['copy', 'source 缺失', {}],
    ['copy', 'source 不是字符串', { source: 5, destination: 'b.txt' }],
    ['move', 'destination 缺失', { source: 'a.txt' }],
    ['move', 'change_context 不是对象', { source: 'a.txt', destination: 'b.txt', change_context: 'x' }],
    [
      'move',
      'change_context 少字段',
      { source: 'a.txt', destination: 'b.txt', change_context: { changeId: 'c' } },
    ],
  ] as const)('类型不对是 rejection 而不是回执（%s / %s）', (operation, _label, args) => {
    expect(() =>
      narrowWorkspacePathOperationArgs(operation, args as Record<string, unknown>),
    ).toThrow()
  })
})

describe('createCopyWorkspacePathHandler / createMoveWorkspacePathHandler', () => {
  it('copy handler 收 snake_case 入参、真复制磁盘、回执键是 camelCase', async () => {
    await writeFile(join(workspace.root, 'a.txt'), 'hello')
    const handler = createCopyWorkspacePathHandler({ homeDir: workspace.base })

    const result = (await handler({
      source: 'a.txt',
      destination: 'b.txt',
      workspace_root: workspace.root,
      change_context: { changeId: 'chg-1', sessionId: 's', runId: 'r', toolCallId: 't' },
    })) as WorkspacePathOperationResult

    expect(result.ok).toBe(true)
    expect(result.operation).toBe('copy')
    expect(result.changeSet).toEqual({ id: 'chg-1', reversible: true })
    await expect(readFile(join(workspace.root, 'b.txt'), 'utf8')).resolves.toBe('hello')
  })

  it('move handler 真的把文件搬走', async () => {
    await writeFile(join(workspace.root, 'a.txt'), 'hello')
    const handler = createMoveWorkspacePathHandler({ homeDir: workspace.base })

    const result = (await handler({
      source: 'a.txt',
      destination: 'moved.txt',
      workspace_root: workspace.root,
      change_context: { changeId: 'chg-2', sessionId: 's', runId: 'r', toolCallId: 't' },
    })) as WorkspacePathOperationResult

    expect(result.ok).toBe(true)
    expect(result.operation).toBe('move')
    await expect(readFile(join(workspace.root, 'moved.txt'), 'utf8')).resolves.toBe('hello')
    await expect(readFile(join(workspace.root, 'a.txt'), 'utf8')).rejects.toThrow()
  })

  it('按设计的拒绝是 ok:false 的回执，不是 rejection', async () => {
    const handler = createCopyWorkspacePathHandler({ homeDir: workspace.base })
    const result = (await handler({
      source: 'missing.txt',
      destination: 'b.txt',
      workspace_root: workspace.root,
      change_context: { changeId: 'chg-3', sessionId: 's', runId: 'r', toolCallId: 't' },
    })) as WorkspacePathOperationResult
    expect(result.ok).toBe(false)
    expect(result.error).toContain('failed to resolve source')
  })
})
