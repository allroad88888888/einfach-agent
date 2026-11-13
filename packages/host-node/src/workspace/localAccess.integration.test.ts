import { readFile, writeFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createNodeHostInvoke } from '../createNodeHostInvoke'
import { createTempWorkspace, type TempWorkspace } from './common/tempWorkspace.testHarness'

let workspace: TempWorkspace
let invoke: ReturnType<typeof createNodeHostInvoke>
let sequence = 0

beforeEach(async () => {
  workspace = await createTempWorkspace()
  invoke = createNodeHostInvoke({ homeDir: workspace.base })
})
afterEach(async () => { await workspace.cleanup() })

function mutate(command: string, args: Record<string, unknown>, full = true) {
  return invoke<{ ok: boolean; changeSet?: { id: string }; change_set?: { id: string }; error?: string }>(command, {
    workspace_root: workspace.root,
    full_local_access: full,
    change_context: { changeId: `access-${++sequence}`, sessionId: 's', runId: 'r', toolCallId: 'c' },
    ...args,
  })
}

describe('local file access through the host command bridge', () => {
  it('confines writes by default and isolates simultaneous full-access requests', async () => {
    const [allowed, denied] = await Promise.all([
      mutate('write_workspace_file', { path: '../allowed.txt', content: 'yes', mode: 'create' }),
      mutate('write_workspace_file', { path: join(workspace.base, 'denied.txt'), content: 'no', mode: 'create' }, false),
    ])
    expect(allowed.ok).toBe(true)
    expect(denied.ok).toBe(false)
    expect(await readFile(join(workspace.base, 'allowed.txt'), 'utf8')).toBe('yes')
    await expect(readFile(join(workspace.base, 'denied.txt'))).rejects.toThrow()
    // A completed privileged request never changes the next request's default.
    expect((await mutate('write_workspace_file', {
      path: '../allowed.txt', content: 'no', mode: 'overwrite',
    }, false)).ok).toBe(false)
  })

  it('patches external files and only restores their journal with full access', async () => {
    const path = join(workspace.base, 'outside.txt')
    await writeFile(path, 'before')
    const change = await mutate('apply_workspace_patch', {
      operations: [{ type: 'replace', path, oldText: 'before', newText: 'after' }],
    })
    expect(change.ok).toBe(true)
    expect(await readFile(path, 'utf8')).toBe('after')
    expect(change.changeSet?.id).toBeTruthy()
    const args = { change_set_id: change.changeSet!.id }
    await expect(mutate('revert_workspace_change', args, false)).rejects.toThrow('invalid path')
    expect(await readFile(path, 'utf8')).toBe('after')
    expect(await mutate('revert_workspace_change', args)).toMatchObject({ ok: true })
    expect(await readFile(path, 'utf8')).toBe('before')
  })

  it('copies, moves and recoverably deletes outside the workspace', async () => {
    const source = join(workspace.base, 'source.txt')
    const copy = join(workspace.base, 'copy.txt')
    const moved = join(workspace.base, 'moved.txt')
    await writeFile(source, 'external')
    expect((await mutate('copy_workspace_path', { source, destination: copy }, false)).ok).toBe(false)
    const copied = await mutate('copy_workspace_path', { source, destination: copy })
    expect(copied.ok).toBe(true)
    const relocated = await mutate('move_workspace_path', { source: copy, destination: moved })
    expect(relocated.ok).toBe(true)
    expect(await readFile(moved, 'utf8')).toBe('external')
    const deleted = await mutate('delete_workspace_path', { path: moved })
    expect(deleted.ok).toBe(true)
    await expect(readFile(moved)).rejects.toThrow()
    for (const id of [deleted.change_set!.id, relocated.changeSet!.id, copied.changeSet!.id]) {
      expect((await mutate('revert_workspace_change', { change_set_id: id })).ok).toBe(true)
    }
    expect(await readFile(source, 'utf8')).toBe('external')
    await expect(readFile(copy)).rejects.toThrow()
    await expect(readFile(moved)).rejects.toThrow()
  })

  it('keeps symlink escapes confined and does not accept a truthy string flag', async () => {
    await symlink(workspace.base, join(workspace.root, 'outside'), 'dir')
    for (const flag of [false, 'true']) {
      const result = await mutate('write_workspace_file', {
        path: 'outside/escaped.txt', content: 'no', full_local_access: flag,
      })
      expect(result.ok).toBe(false)
    }
    expect((await mutate('write_workspace_file', {
      path: 'outside/escaped.txt', content: 'yes', mode: 'create',
    })).ok).toBe(true)
    expect(await readFile(join(workspace.base, 'escaped.txt'), 'utf8')).toBe('yes')
  })
})
