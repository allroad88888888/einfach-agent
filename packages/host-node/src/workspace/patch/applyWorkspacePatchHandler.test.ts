import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  applyWorkspacePatch,
  createApplyWorkspacePatchHandler,
  narrowApplyWorkspacePatchArgs,
} from './applyWorkspacePatchHandler'
import { createPatchRoutes } from './index'
import { createTempWorkspace, type TempWorkspace } from '../common/tempWorkspace.testHarness'
import type { WorkspacePatchResult } from './result'

let workspace: TempWorkspace

beforeEach(async () => {
  workspace = await createTempWorkspace()
})

afterEach(async () => {
  await workspace.cleanup()
})

const path = (name: string) => join(workspace.root, name)

describe('narrowApplyWorkspacePatchArgs', () => {
  it('顶层键是 snake_case，operations 里的载荷是 camelCase', () => {
    const request = narrowApplyWorkspacePatchArgs({
      operations: [{ type: 'replace', path: 'a.txt', oldText: 'x', newText: 'y' }],
      dry_run: true,
      workspace_root: '/tmp/ws',
      change_context: {
        changeId: 'chg',
        sessionId: 'sess',
        runId: 'run',
        toolCallId: 'call',
      },
      diagnostic_operation_id: 'op-1',
    })

    expect(request).toEqual({
      operations: [{ type: 'replace', path: 'a.txt', oldText: 'x', newText: 'y' }],
      dryRun: true,
      workspaceRoot: '/tmp/ws',
      changeContext: { changeId: 'chg', sessionId: 'sess', runId: 'run', toolCallId: 'call' },
    })
  })

  it('缺席只看值：键存在但为 undefined / null 与没传等价', () => {
    // core 的 toTauriInput 整份对象字面量返回，可选项没值时键存在且为 undefined；走 HTTP 时
    // JSON.stringify 又会把它丢掉。用 `'key' in args` 会让同一份入参在两条路上给出不同结果。
    const explicit = narrowApplyWorkspacePatchArgs({
      operations: [],
      dry_run: undefined,
      workspace_root: null,
      change_context: undefined,
    })
    expect(explicit).toEqual({ operations: [], dryRun: false })
    expect(narrowApplyWorkspacePatchArgs({ operations: [] })).toEqual(explicit)
  })

  it('操作形状不对 = 整条命令失败，不是记一条 rejected', () => {
    // rejected[] 的语义是「这条操作的语义不成立」；把「你传的 JSON 不对」混进去，模型会以为
    // 改改内容重试就行。
    expect(() => narrowApplyWorkspacePatchArgs({ operations: [{ type: 'nope' }] })).toThrow(
      /operations\[0\]\.type/,
    )
    expect(() => narrowApplyWorkspacePatchArgs({ operations: 'not-an-array' })).toThrow(
      'operations 必须是数组',
    )
  })

  it('类型不对的顶层可选参数直接拒', () => {
    expect(() => narrowApplyWorkspacePatchArgs({ operations: [], dry_run: 'yes' })).toThrow(
      'apply_workspace_patch 的 dry_run 必须是布尔值',
    )
    expect(() => narrowApplyWorkspacePatchArgs({ operations: [], workspace_root: 7 })).toThrow(
      'apply_workspace_patch 的 workspace_root 必须是字符串',
    )
  })

  it('change_context 四个字段全都必填——缺一个就记不成一条完整的账', () => {
    expect(() =>
      narrowApplyWorkspacePatchArgs({
        operations: [],
        change_context: { changeId: 'chg', sessionId: 'sess', runId: 'run' },
      }),
    ).toThrow('apply_workspace_patch 的 change_context.toolCallId 必须是字符串')
    expect(() =>
      narrowApplyWorkspacePatchArgs({ operations: [], change_context: 'chg' }),
    ).toThrow('apply_workspace_patch 的 change_context 必须是对象')
  })
})

describe('applyWorkspacePatch', () => {
  it('不带 change_context 就不碰日志目录（一次不可回滚的直接写）', async () => {
    await writeFile(path('a.txt'), 'old')
    const journal = join(workspace.base, 'journal')

    const result = await applyWorkspacePatch(journal, {
      operations: [{ type: 'replace', path: 'a.txt', oldText: 'old', newText: 'new' }],
      dryRun: false,
      workspaceRoot: workspace.root,
    })

    expect(result.changeSet).toBeNull()
    await expect(readdir(journal)).rejects.toThrow()
    await expect(readFile(path('a.txt'), 'utf8')).resolves.toBe('new')
  })

  it('带 change_context 时把日志目录接进流水线', async () => {
    await writeFile(path('a.txt'), 'old')
    const journal = join(workspace.base, 'journal')

    const result = await applyWorkspacePatch(journal, {
      operations: [{ type: 'replace', path: 'a.txt', oldText: 'old', newText: 'new' }],
      dryRun: false,
      workspaceRoot: workspace.root,
      changeContext: { changeId: 'chg', sessionId: 's', runId: 'r', toolCallId: 'c' },
    })

    expect(result.changeSet).toEqual({ id: 'chg', reversible: true })
    expect(await readdir(journal)).toEqual(['chg.json'])
  })
})

describe('createPatchRoutes', () => {
  it('登记的是 apply_workspace_patch，且真能跑通一轮', async () => {
    await writeFile(path('a.txt'), 'old')
    const routes = createPatchRoutes({ homeDir: workspace.base })
    const handler = routes.apply_workspace_patch

    expect(Object.keys(routes)).toEqual(['apply_workspace_patch'])
    expect(handler).toBeTypeOf('function')

    const result = (await handler?.({
      operations: [{ type: 'replace', path: 'a.txt', oldText: 'old', newText: 'new' }],
      workspace_root: workspace.root,
    })) as WorkspacePatchResult

    expect(result.ok).toBe(true)
    expect(result.changedFiles).toEqual(['a.txt'])
    await expect(readFile(path('a.txt'), 'utf8')).resolves.toBe('new')
  })

  it('工厂形态：日志目录在建路由时定一次，不是每次调用重算', () => {
    // 与 change 域的 revert handler 同款——`defaultJournalDirectory` 是唯一来源，没有覆盖槽。
    expect(() => createApplyWorkspacePatchHandler({ homeDir: workspace.base })).not.toThrow()
  })
})
