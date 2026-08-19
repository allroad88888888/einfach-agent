// 拆分自 modelRun.test.ts（T1）。原文件同名 describe 段落逐字迁移。

import { describe, it, expect, afterEach, vi } from 'vitest'
import { rootStore, sessionsAtom, workspacesAtom } from '../state/rootStore'
import { getSessionStore } from '../state/sessionStore'
import { itemsAtom, runAtom } from '../state/sessionAtoms'
import { setRun } from '../state/sessionWriters'
import { resumeInterruptedSession, runToolLoop } from './modelRun'
import { createCoreInstance } from './core/coreInstance'
import { registerStandardTools } from '@einfach-agent/tools'
import { resetModelRunTestState, seedSession, jsonResponse } from './modelRun.testHarness'

afterEach(() => {
  resetModelRunTestState()
})

describe('runToolLoop（resume 复用的循环入口，T-7）', () => {
  it('重启中断恢复：unknown 工具结果保持 interrupted，且不重放或请求模型', async () => {
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
    setRun('restart-resume', {
      runId: 'original-run',
      turnId: 'u1',
      status: 'interrupted',
      toolCallOutcomes: {
        'write-1': { state: 'outcomeUnknown', updatedAt: 3 },
      },
    })
    let requestCount = 0
    const fetchImpl: typeof fetch = async () => {
      requestCount += 1
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
      status: 'interrupted',
      toolCallOutcomes: {
        'write-1': { state: 'outcomeUnknown' },
      },
    })
    expect(store.getter(itemsAtom).map(({ item }) => item.role)).toEqual(['user', 'assistant'])
    expect(requestCount).toBe(0)
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
      {
        id: 'current-assistant',
        createdAt: 3,
        item: {
          role: 'assistant' as const,
          content: null,
          tool_calls: [{
            id: 'reconciled-tool',
            type: 'function' as const,
            function: { name: 'read_file', arguments: JSON.stringify({ path: 'a.txt' }) },
          }],
        },
      },
      {
        id: 'reconciled-tool-result',
        createdAt: 4,
        item: {
          role: 'tool' as const,
          tool_call_id: 'reconciled-tool',
          content: JSON.stringify({ ok: true }),
        },
      },
    ]
    store.setter(itemsAtom, currentItems)
    setRun('mixed-checkpoint-resume', {
      runId: 'structured-run',
      turnId: 'current-user',
      status: 'interrupted',
      toolCallOutcomes: {
        'reconciled-tool': { state: 'outcomeKnown', updatedAt: 4 },
      },
    })

    await resumeInterruptedSession('mixed-checkpoint-resume', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl: async () => jsonResponse('新任务已完成'),
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
  })
})
