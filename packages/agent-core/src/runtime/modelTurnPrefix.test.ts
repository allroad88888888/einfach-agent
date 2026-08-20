import { describe, expect, it, vi } from 'vitest'
import type { ModelItem } from '@einfach-agent/ai'
import { disabledProjectSkillsByWorkspaceAtom, workspacesAtom } from '../state/rootStore'
import type { SessionMeta } from '../state/core.type'
import type { ProjectSkillsSnapshot } from '../skills/projectSkills'
import type { SkillsRegistry } from '../skills/contracts'
import { createContextCacheTracker } from './contextCache'
import { createCoreInstance } from './core/coreInstance'
import { buildStableModelPrefix, type StableModelPrefix } from './modelTurnPrefix'

function session(workspaceId?: string): SessionMeta {
  return {
    id: 'prefix-session',
    title: '前缀测试',
    settings: { vendor: 'deepseek', model: 'deepseek-v4-flash' },
    createdAt: 0,
    updatedAt: 0,
    ...(workspaceId ? { workspaceId } : {}),
  }
}

function scanned(...names: string[]): ProjectSkillsSnapshot {
  return {
    workspaceRoot: '/workspace',
    entries: names.map((name) => ({
      name,
      description: `${name} 的用途`,
      triggers: [],
      rootPath: '/workspace',
      filePath: `.webAgent/skills/${name}/SKILL.md`,
      resources: {},
      origin: 'agent' as const,
      scope: 'project' as const,
    })),
    diagnostics: [],
  }
}

function coreWith(opts: {
  buildManifestText: SkillsRegistry['buildManifestText']
  projectSkillsProvider?: (workspaceRoot: string) => Promise<ProjectSkillsSnapshot>
}) {
  const core = createCoreInstance({
    skillRegistry: { buildManifestText: opts.buildManifestText, list: () => [] },
    projectSkillsProvider: opts.projectSkillsProvider,
  })
  core.rootStore.setter(workspacesAtom, {
    workspace: {
      id: 'workspace',
      name: '工作区',
      rootPath: '/workspace/',
      createdAt: 0,
      updatedAt: 0,
    },
  })
  return core
}

describe('buildStableModelPrefix', () => {
  it('L1 清单是稳定前缀的一段：扫描一次、排在运行环境之前，且整段进 content', async () => {
    const snapshot = scanned('project/release-check')
    const projectSkillsProvider = vi.fn(async () => snapshot)
    const buildManifestText = vi.fn(() => '可用 skills：\n· project/release-check — 发布前检查')
    const core = coreWith({ buildManifestText, projectSkillsProvider })
    const ensure = vi.spyOn(core.projectSkills, 'ensure')

    const prefix = await buildStableModelPrefix(session('workspace'), core)

    expect(ensure).toHaveBeenCalledExactlyOnceWith('/workspace')
    expect(projectSkillsProvider).toHaveBeenCalledExactlyOnceWith('/workspace')
    // 清单文本由 tools-skills 的 registry 产出，core 只经注入槽拿它——core 不 import tools-*。
    expect(buildManifestText).toHaveBeenCalledExactlyOnceWith(snapshot)
    expect(prefix.skillManifest.content).toBe('可用 skills：\n· project/release-check — 发布前检查')
    // 顺序即 provider 前缀缓存契约：与 workspace 无关的三段在前，按 workspace 变的两段垫底。
    expect(prefix.items).toEqual([
      prefix.system,
      prefix.toolManifest,
      prefix.skillManifest,
      prefix.environment,
    ])
    expect(prefix.content).toBe(prefix.items.map((item) => item.content).join('\n'))
    expect(prefix.content).toContain('· project/release-check — 发布前检查')
  })

  it('未绑定 workspace 时不扫描，清单只剩内置段', async () => {
    const buildManifestText = vi.fn(() => '可用 skills：（仅内置）')
    const core = coreWith({ buildManifestText })
    const ensure = vi.spyOn(core.projectSkills, 'ensure')

    const prefix = await buildStableModelPrefix(session(), core)

    expect(ensure).not.toHaveBeenCalled()
    expect(buildManifestText).toHaveBeenCalledExactlyOnceWith(undefined)
    expect(prefix.workspaceRoot).toBeUndefined()
  })

  it('当前 workspace 停用的项目 skill 不进清单（与 ctx.skills 读同一份判据）', async () => {
    let passed: ProjectSkillsSnapshot | undefined
    const core = coreWith({
      buildManifestText: (snapshot) => {
        passed = snapshot
        return '清单'
      },
      projectSkillsProvider: async () => scanned('project/release-check', 'project/legacy-guide'),
    })
    core.rootStore.setter(disabledProjectSkillsByWorkspaceAtom, {
      workspace: ['project/legacy-guide'],
    })

    await buildStableModelPrefix(session('workspace'), core)

    expect(passed?.entries.map((entry) => entry.name)).toEqual(['project/release-check'])
  })

  it('清单变化被 contextCache 归因为 profile_changed，而不是尾巴动态变化', async () => {
    // 本卡（C7）的全部意义：清单待在稳定前缀里，改了它就换 epoch、一次性全量 miss；
    // 挂在历史尾巴上则每轮被新历史顶位，变成持续 miss。归因就是这两种世界的分界线。
    let manifest = '可用 skills：\n· planning — 何时用…'
    const core = coreWith({ buildManifestText: () => manifest })
    const tracker = createContextCacheTracker()
    const user: ModelItem = { role: 'user', content: 'hi' }
    const observe = (prefix: StableModelPrefix) => tracker.observe({
      lane: 'main',
      scope: 'prefix-session:run-1:root',
      vendor: 'deepseek',
      model: 'deepseek-v4-flash',
      messages: [...prefix.items, user],
      // 主循环传的就是整段前缀正文（modelTurnRequester 的 systemContent: stablePrefix.content）。
      systemContent: prefix.content,
      tools: [],
      toolChoice: 'auto',
      compacted: false,
      // 尾巴为空：清单不在动态控制项里，所以下面的 epoch bump 只可能来自前缀本身。
      dynamicControls: [],
      requestMode: 'tool_loop',
    })

    const before = observe(await buildStableModelPrefix(session('workspace'), core))
    manifest = `${manifest}\n· project/release-check — 发布前检查`
    const after = observe(await buildStableModelPrefix(session('workspace'), core))

    expect(before.epoch).toBe(1)
    expect(before.epochReason).toBe('initial')
    expect(after.epoch).toBe(2)
    expect(after.epochReason).toBe('profile_changed')
    expect(after.epochCauses).toContain('system_changed')
    // 尾巴什么都没变：这一轮的 miss 不可能被记到动态控制项头上。
    expect(after.epochCauses).not.toContain('dynamic_control_changed')
    expect(after.systemFingerprint).not.toBe(before.systemFingerprint)
    expect(after.profileId).not.toBe(before.profileId)
  })
})
