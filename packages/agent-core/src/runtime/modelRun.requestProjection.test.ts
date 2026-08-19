// 拆分自 modelRun.test.ts（T1）。P-R2 单轮 run 里「发给模型的请求长什么样」：
// vendor/thinking 设置转发、L1 skills 清单、有本机能力时的 server 工具发现、稳定前缀顺序、
// 运行环境注入。

import { describe, it, expect, afterEach, vi } from 'vitest'
import { rootStore, sessionsAtom, workspacesAtom } from '../state/rootStore'
import { getSessionStore } from '../state/sessionStore'
import { itemsAtom } from '../state/sessionAtoms'
import { runtimeTranscriptEventsAtom } from '../state/transientAtoms'
import { toolRegistry } from '../tools/registry'
import { buildToolManifestText } from './modelTurn'
import type { ModelFunctionTool } from '@web-agent/ai'
import { runSession } from './modelRun'
import { createCoreInstance } from './core/coreInstance'
import { buildSkillManifestText, registerStandardTools } from '@web-agent/tools'
import { resetModelRunTestState, seedSession, jsonResponse } from './modelRun.testHarness'
import { stubHostBridgeFlag } from './hostBridge.testHarness'

// modelTurnPrefix.ts 的工具发现读 hasHostBridge()（见 runtime/hostBridge.ts），既不经过
// '@tauri-apps/api/core' 的 isTauri 导出，也不再读 globalThis.isTauri：
//   · vi.mock('@tauri-apps/api/core', { isTauri: ... }) 分量随 D2 迁移失效，已于 D8 删除；
//   · globalThis.isTauri 分量（stubTauriHostFlag）随 H4b 把总闸从「是不是 Tauri」改判成
//     「宿主有没有登记 host bridge」而失效——留着它用例仍会跑，但下面那两条“Tauri 下能发现
//     shell_macos”的断言会静默变成“在没有本机能力的宿主上跑”，比失败更糟。
// 现在统一用 stubHostBridgeFlag 登记/清空 hostBridge 的 loader，它才是总闸真正读的东西。

afterEach(() => {
  resetModelRunTestState()
  stubHostBridgeFlag(false)
})

describe('runSession（P-R2）请求投影：设置转发与稳定前缀构造', () => {
  it('DeepSeek thinking 请求保留会话设置，但只转发兼容的 thinking/reasoning_effort', async () => {
    seedSession('s5', {
      vendor: 'deepseek',
      model: 'm',
      temperature: 0.5,
      thinking: true,
      // 特化字段走设置袋：core 只搬运，由 DeepSeek adapter 解释并上行。
      vendorSettings: { reasoning_effort: 'high' },
    })
    let captured: Record<string, unknown> = {}
    const fetchImpl: typeof fetch = (_url, init) => {
      captured = JSON.parse(init!.body as string)
      return Promise.resolve(jsonResponse('ok'))
    }

    await runSession('s5', 'hi', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
    })

    expect(captured.model).toBe('m')
    expect(captured).not.toHaveProperty('temperature')
    expect(captured.thinking).toEqual({ type: 'enabled' })
    expect(captured.reasoning_effort).toBe('high')
    const restoredSettings = rootStore.getter(sessionsAtom).s5.settings
    expect(restoredSettings.temperature).toBe(0.5)
  })

  it('L1 清单以 sessionStart timed tool 可达模型，稳定前缀和转录不再注入 skills', async () => {
    const workspaceRoot = '/workspace/project-skills'
    const projectSkills = {
      workspaceRoot,
      entries: [{
        name: 'project/release-check',
        description: '何时用：发布前检查部署流程。',
        triggers: ['发布'],
        filePath: '.agents/skills/release-check/SKILL.md',
        resources: {},
        origin: 'agent' as const,
        scope: 'project' as const,
        rootPath: '/workspace',
      }],
      diagnostics: [],
    }
    const projectSkillsProvider = vi.fn(async () => projectSkills)
    const core = createCoreInstance({ registerTools: registerStandardTools, projectSkillsProvider })
    const id = 'inject1'
    core.rootStore.setter(workspacesAtom, {
      workspace: { id: 'workspace', name: '项目 skills', rootPath: workspaceRoot, createdAt: 0, updatedAt: 0 },
    })
    core.rootStore.setter(sessionsAtom, {
      [id]: {
        id,
        title: 't',
        settings: { vendor: 'deepseek', model: 'm' },
        workspaceId: 'workspace',
        createdAt: 0,
        updatedAt: 0,
      },
    })
    let captured: Record<string, unknown> = {}
    const fetchImpl: typeof fetch = (_url, init) => {
      captured = JSON.parse(init!.body as string)
      return Promise.resolve(jsonResponse('ok'))
    }

    await runSession(id, 'hi', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
      core,
    })

    const store = core.getSessionStore(id).store
    const items = store.getter(itemsAtom)
    expect(items.some((it) => it.item.role === 'system')).toBe(false)
    expect(items.map(({ item }) => item.role)).toEqual(['user', 'tool', 'assistant'])
    const timedItem = items.find(
      ({ item }) => item.role === 'tool' && item.tool_call_id === 'timed:sessionStart:skill_manifest',
    )?.item
    if (!timedItem || timedItem.role !== 'tool') throw new Error('缺少 sessionStart skills 清单')

    const messages = captured.messages as Array<{
      role: string
      content?: string | null
      tool_call_id?: string
      tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>
    }>
    expect(messages[0].role).toBe('system')
    expect(messages[0].content).not.toContain('可用 skills')
    expect(messages[0].content).toContain('禁止凭工具名猜参数')
    // stable prefix 只有固定 system、工具摘要和环境；L1 在首轮 user 之后以 timed result 到达模型。
    expect(messages.map((item) => item.role)).toEqual(['system', 'system', 'system', 'user', 'assistant', 'tool'])
    expect(messages[1].content).toBe(buildToolManifestText(false, { registry: core.tools }))
    expect(messages[1].content).toContain('· skill_search [internal]')
    expect(messages[1].content).not.toContain('· shell_macos [server]')
    expect(messages[2].content).toContain('运行环境：')
    expect(messages[3]).toMatchObject({ role: 'user', content: 'hi' })
    expect(messages[4]).toMatchObject({
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'timed:sessionStart:skill_manifest',
        type: 'function',
        function: { name: 'timed_tool_result', arguments: '{}' },
      }],
    })
    expect(messages[5]).toMatchObject({ role: 'tool', tool_call_id: 'timed:sessionStart:skill_manifest' })
    const manifestText = JSON.parse(String(messages[5].content)) as string
    expect(manifestText).toBe(buildSkillManifestText(projectSkills))
    expect(manifestText).toBe(JSON.parse(timedItem.content))
    expect(manifestText).toContain('· planning — 何时用：任务跨多个阶段/模块')
    expect(manifestText).toContain('· project/release-check — 何时用：发布前检查部署流程。')
    expect(projectSkillsProvider).toHaveBeenCalledExactlyOnceWith(workspaceRoot)

    const events = store.getter(runtimeTranscriptEventsAtom)
    expect(events.some((event) => event.title === '注入 skill 清单')).toBe(false)
    expect(
      events.some((event) =>
        event.kind === 'system_injection'
        && event.title === '注入工具摘要清单'
        && event.detail === buildToolManifestText(false, { registry: core.tools })),
    ).toBe(true)
    expect(events.some((event) => event.kind === 'tool_manifest' && event.detail?.includes('request_tool_schema'))).toBe(
      true,
    )
  })

  it('有本机能力的宿主首轮请求能发现 shell_macos，但未加载前仍不把它作为可调用 function 暴露', async () => {
    stubHostBridgeFlag(true)
    seedSession('inject-tauri-tools', { vendor: 'deepseek', model: 'm' })
    let captured: Record<string, unknown> = {}
    const fetchImpl: typeof fetch = (_url, init) => {
      captured = JSON.parse(init!.body as string)
      return Promise.resolve(jsonResponse('ok'))
    }

    await runSession('inject-tauri-tools', '检查本机项目', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
    })

    const messages = captured.messages as Array<{ role: string; content?: string }>
    expect(messages[1].content).toBe(buildToolManifestText(true, { registry: toolRegistry }))
    expect(messages[1].content).toContain('· shell_macos [server]')

    const exposedToolNames = (captured.tools as ModelFunctionTool[])
      .map((tool) => tool.function.name)
    expect(exposedToolNames).toEqual(['request_tool_schema'])
  })

  it('稳定前缀四段有序：固定 system → 工具摘要 → 自定义指令 → 运行环境；L1 走历史 timed item', async () => {
    // 清单由 sessionStart 工具写入历史，不再把 workspace skill 的变动纳入 stable prefix。其余低频
    // 内容仍按变更频率固定，环境垫底以尽量让不同 workspace 共享此前缀。
    const core = createCoreInstance({
      config: { customInstructions: '  请始终使用中文回复\n' },
      registerTools: registerStandardTools,
    })
    const id = 'custom-instructions-prefix'
    core.rootStore.setter(sessionsAtom, {
      [id]: {
        id,
        title: 't',
        settings: { vendor: 'deepseek', model: 'm' },
        createdAt: 0,
        updatedAt: 0,
      },
    })
    let captured: Record<string, unknown> = {}
    const fetchImpl: typeof fetch = (_url, init) => {
      captured = JSON.parse(init!.body as string)
      return Promise.resolve(jsonResponse('ok'))
    }

    await runSession(id, 'hi', {
      signal: new AbortController().signal,
      apiKey: 'k',
      fetchImpl,
      core,
    })

    const marker = '用户在设置中保存了以下长期自定义指令'
    const messages = captured.messages as Array<{ role: string; content?: string }>
    // [固定 system, 工具摘要, 自定义指令, 运行环境, user, timed 配对 assistant, timed tool]。
    expect(messages.map((item) => item.role)).toEqual(['system', 'system', 'system', 'system', 'user', 'assistant', 'tool'])
    expect(messages[0].content).toContain('禁止凭工具名猜参数')
    expect(messages[0].content).not.toContain(marker)
    expect(messages[1].content).toBe(buildToolManifestText(false, { registry: core.tools }))
    expect(messages[2].content).toContain(marker)
    expect(messages[2].content).toContain('请始终使用中文回复')
    expect(messages[3].content).toContain('运行环境：')
    expect(messages[4]).toMatchObject({ role: 'user', content: 'hi' })
    expect(messages[5]).toMatchObject({
      role: 'assistant',
      tool_calls: [{ id: 'timed:sessionStart:skill_manifest' }],
    })
    expect(messages[6]).toMatchObject({ role: 'tool', tool_call_id: 'timed:sessionStart:skill_manifest' })
    // 自定义指令只此一份，且不在历史之后。
    expect(messages.filter((item) => item.content?.includes(marker))).toHaveLength(1)

    const events = core.getSessionStore(id).store.getter(runtimeTranscriptEventsAtom)
    expect(events.some((event) => event.kind === 'system_injection' && event.detail?.includes(marker))).toBe(true)
  })

  it('运行环境段把会话绑定的 workspace 根目录送进请求（缺它模型只能猜路径）', async () => {
    // 回归用例。缺这一段时的实测事故：DeepSeek 首轮直接对
    // /Users/<某人>/develop/android/... 发 read_file，报 WORKSPACE_READ_FAILED，
    // 模型是从错误文案里才第一次看到真实根目录，白烧三轮。
    // 有本机能力才会走到「本机能力：可用 + 当前工作区根目录」那一支；
    // 无能力时运行环境段根本不报根目录，下面的断言就落空了。
    stubHostBridgeFlag(true)
    const core = createCoreInstance()
    const id = 'env-workspace'
    core.rootStore.setter(workspacesAtom, {
      ws1: { id: 'ws1', name: 'web-agent', rootPath: '/Volumes/work/ai/web-agent/', createdAt: 0, updatedAt: 0 },
    })
    core.rootStore.setter(sessionsAtom, {
      [id]: {
        id,
        title: 't',
        settings: { vendor: 'deepseek', model: 'm' },
        workspaceId: 'ws1',
        createdAt: 0,
        updatedAt: 0,
      },
    })
    let captured: Record<string, unknown> = {}
    const fetchImpl: typeof fetch = (_url, init) => {
      captured = JSON.parse(init!.body as string)
      return Promise.resolve(jsonResponse('ok'))
    }

    await runSession(id, '了解下这个项目', { signal: new AbortController().signal, apiKey: 'k', fetchImpl, core })

    const messages = captured.messages as Array<{ role: string; content?: string }>
    const environment = messages[2]
    // 运行环境是稳定前缀最后一段。
    expect(environment?.role).toBe('system')
    expect(environment?.content).toContain('当前工作区根目录：/Volumes/work/ai/web-agent')
    expect(environment?.content).not.toContain('/Volumes/work/ai/web-agent/\n')
    expect(messages[3]).toMatchObject({ role: 'user', content: '了解下这个项目' })

    const events = core.getSessionStore(id).store.getter(runtimeTranscriptEventsAtom)
    expect(
      events.some((event) => event.title === '注入运行环境' && event.detail?.includes('/Volumes/work/ai/web-agent')),
    ).toBe(true)
  })
})
