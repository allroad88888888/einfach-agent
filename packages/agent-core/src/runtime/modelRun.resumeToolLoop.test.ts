// 拆分自 modelRun.test.ts（T1）。原文件同名 describe 段落逐字迁移。

import { describe, it, expect, afterEach, vi } from 'vitest'
import { rootStore, sessionsAtom, workspacesAtom } from '../state/rootStore'
import { getSessionStore } from '../state/sessionStore'
import { itemsAtom, runAtom, checkpointsAtom } from '../state/sessionAtoms'
import { setRun } from '../state/sessionWriters'
import { resumeInterruptedSession, runToolLoop } from './modelRun'
import { createCoreInstance } from './core/coreInstance'
import { registerStandardTools } from '@web-agent/tools'
import { resetModelRunTestState, seedSession, jsonResponse } from './modelRun.testHarness'

afterEach(() => {
  resetModelRunTestState()
})

describe('runToolLoop（resume 复用的循环入口，T-7）', () => {
  it('重启中断恢复：沿用原 run/checkpoint，孤儿写工具按 unknown 闭合且不自动重放', async () => {
    seedSession('restart-resume', { vendor: 'deepseek', model: 'x' })
    const store = getSessionStore('restart-resume').store
    const interruptedItems = [
      { id: 'u1', createdAt: 1, item: { role: 'user' as const, content: '修改文件' } },
      {
        id: 'a1',
        createdAt: 2,
        item: {
          role: 'assistant' as const,
          content: null,
          tool_calls: [{
            id: 'write-1',
            type: 'function' as const,
            function: {
              name: 'write_file',
              arguments: JSON.stringify({ path: 'a.txt', content: 'new' }),
            },
          }],
        },
      },
    ]
    store.setter(itemsAtom, interruptedItems)
    store.setter(checkpointsAtom, [{
      turnIndex: 0,
      label: '[执行中] 修改文件',
      createdAt: 3,
      items: interruptedItems,
      recovery: {
        run: {
          runId: 'original-run',
          turnId: 'u1',
          status: 'interrupted',
        },
      },
    }])
    setRun('restart-resume', {
      runId: 'original-run',
      turnId: 'u1',
      status: 'interrupted',
    })
    let requestMessages: Array<{ role: string; tool_call_id?: string; content?: string }> = []
    const fetchImpl: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: typeof requestMessages }
      requestMessages = body.messages
      return jsonResponse('已检查并继续完成')
    }

    await resumeInterruptedSession('restart-resume', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
    })

    expect(store.getter(runAtom)).toMatchObject({
      runId: 'original-run',
      turnId: 'u1',
      status: 'done',
    })
    expect(store.getter(itemsAtom).map(({ item }) => item.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'assistant',
    ])
    const interruptedToolResult = store.getter(itemsAtom)[2].item
    if (interruptedToolResult.role !== 'tool') throw new Error('意外的条目形状')
    expect(interruptedToolResult.tool_call_id).toBe('write-1')
    expect(JSON.parse(interruptedToolResult.content)).toMatchObject({
      interrupted: true,
      result: 'unknown',
    })
    expect(requestMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'tool',
        tool_call_id: 'write-1',
        content: expect.stringContaining('"interrupted":true'),
      }),
    ]))
    const checkpoints = store.getter(checkpointsAtom)
    expect(checkpoints).toHaveLength(1)
    expect(checkpoints[0]).toMatchObject({
      turnIndex: 0,
      label: '修改文件',
      kind: 'completed',
      recovery: undefined,
    })
  })

  it('恢复已有 sessionStart skills 清单时不重复 ensure 或写入 timed item', async () => {
    const workspaceRoot = '/workspace/resumed-skills'
    const projectSkillsProvider = vi.fn(async () => ({ workspaceRoot, entries: [], diagnostics: [] }))
    const core = createCoreInstance({ registerTools: registerStandardTools, projectSkillsProvider })
    const id = 'resume-existing-skill-manifest'
    core.rootStore.setter(workspacesAtom, {
      workspace: { id: 'workspace', name: '恢复工作区', rootPath: workspaceRoot, createdAt: 0, updatedAt: 0 },
    })
    core.rootStore.setter(sessionsAtom, {
      [id]: {
        id,
        title: 't',
        workspaceId: 'workspace',
        settings: { vendor: 'deepseek', model: 'x' },
        createdAt: 0,
        updatedAt: 0,
      },
    })
    const store = core.getSessionStore(id).store
    store.setter(itemsAtom, [
      { id: 'user', createdAt: 1, item: { role: 'user' as const, content: '继续执行' } },
      {
        id: 'existing-skill-manifest',
        createdAt: 2,
        item: {
          role: 'tool' as const,
          tool_call_id: 'timed:sessionStart:skill_manifest',
          content: JSON.stringify('可用 skills：\n· planning — 何时用：任务跨多个阶段/模块'),
        },
      },
    ])
    setRun(id, { runId: 'interrupted-run', turnId: 'user', status: 'interrupted' }, core)
    let requestMessages: Array<{ role: string; tool_call_id?: string; content?: string }> = []

    await resumeInterruptedSession(id, {
      signal: new AbortController().signal,
      apiKey: 'k',
      core,
      fetchImpl: async (_url, init) => {
        requestMessages = (JSON.parse(String(init?.body)) as { messages: typeof requestMessages }).messages
        return jsonResponse('已恢复')
      },
    })

    expect(projectSkillsProvider).not.toHaveBeenCalled()
    expect(store.getter(itemsAtom).filter(
      ({ item }) => item.role === 'tool' && item.tool_call_id === 'timed:sessionStart:skill_manifest',
    )).toHaveLength(1)
    expect(requestMessages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'timed:sessionStart:skill_manifest',
          type: 'function',
          function: { name: 'timed_tool_result', arguments: '{}' },
        }],
      }),
      expect.objectContaining({
        role: 'tool',
        tool_call_id: 'timed:sessionStart:skill_manifest',
      }),
    ]))
  })

  it('新旧工作 checkpoint 共存时，结构化最新记录续跑且不误改旧前缀记录', async () => {
    seedSession('mixed-checkpoint-resume', { vendor: 'deepseek', model: 'x' })
    const store = getSessionStore('mixed-checkpoint-resume').store
    const legacyItems = [
      { id: 'legacy-user', createdAt: 1, item: { role: 'user' as const, content: '旧任务' } },
    ]
    const currentItems = [
      { id: 'current-user', createdAt: 2, item: { role: 'user' as const, content: '新任务' } },
    ]
    store.setter(itemsAtom, currentItems)
    store.setter(checkpointsAtom, [
      {
        turnIndex: 0,
        label: '[执行中] 旧任务',
        createdAt: 1,
        items: legacyItems,
        recovery: {
          run: { runId: 'legacy-run', turnId: 'legacy-user', status: 'interrupted' },
        },
      },
      {
        turnIndex: 1,
        label: '新任务',
        kind: 'working',
        createdAt: 2,
        items: currentItems,
        recovery: {
          run: { runId: 'structured-run', turnId: 'current-user', status: 'interrupted' },
        },
      },
    ])
    setRun('mixed-checkpoint-resume', {
      runId: 'structured-run',
      turnId: 'current-user',
      status: 'interrupted',
    })

    await resumeInterruptedSession('mixed-checkpoint-resume', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl: async () => jsonResponse('新任务已完成'),
    })

    const checkpoints = store.getter(checkpointsAtom)
    expect(checkpoints).toHaveLength(2)
    expect(checkpoints[0]).toMatchObject({
      label: '[执行中] 旧任务',
      recovery: { run: { runId: 'legacy-run' } },
    })
    expect(checkpoints[0]).not.toHaveProperty('kind')
    expect(checkpoints[1]).toMatchObject({
      turnIndex: 1,
      label: '新任务',
      kind: 'completed',
      recovery: undefined,
    })
    expect(store.getter(runAtom)).toMatchObject({ runId: 'structured-run', status: 'done' })
  })

  it('直接跑 runToolLoop：seed items + setRun 后跑到 done，不 append user', async () => {
    seedSession('r1', { vendor: 'deepseek', model: 'x' })
    const store = getSessionStore('r1').store
    // 预置一条 user（模拟暂停前已在库）+ 一个 pending run —— runToolLoop 不再 append user。
    store.setter(itemsAtom, [{ id: 'u1', createdAt: 1, item: { role: 'user', content: 'hi' } }])
    setRun('r1', { runId: 'R1', status: 'running' })
    const fetchImpl: typeof fetch = async () => jsonResponse('答案')

    await runToolLoop('r1', 'R1', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
    })

    const items = store.getter(itemsAtom)
    // 复用已有 user；sessionStart 清单后才 append 最终 assistant。
    expect(items.map((it) => it.item.role)).toEqual(['user', 'tool', 'assistant'])
    expect(items[2].item).toEqual({ role: 'assistant', content: '答案' })
    expect(store.getter(runAtom)?.status).toBe('done')
    // 一轮收尾 = 一个 checkpoint。
    expect(store.getter(checkpointsAtom)).toHaveLength(1)
  })
})
