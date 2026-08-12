import { describe, expect, it, vi } from 'vitest'
import { workspacesAtom } from '../state/rootStore'
import type { SessionMeta } from '../state/core.type'
import type { SkillsRegistry } from '../skills/contracts'
import { createCoreInstance } from './core/coreInstance'
import { buildStableModelPrefix } from './modelTurnPrefix'

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

describe('buildStableModelPrefix', () => {
  it('不扫描或组装 skills，L1 清单留给 sessionStart timeline item', async () => {
    const buildManifestText = vi.fn(() => '不应出现在稳定前缀的 skills 清单')
    const skillsRegistry: SkillsRegistry = { buildManifestText, list: () => [] }
    const core = createCoreInstance({ skillRegistry: skillsRegistry })
    core.rootStore.setter(workspacesAtom, {
      workspace: {
        id: 'workspace',
        name: '工作区',
        rootPath: '/workspace/',
        createdAt: 0,
        updatedAt: 0,
      },
    })
    const ensure = vi.spyOn(core.projectSkills, 'ensure')

    const prefix = await buildStableModelPrefix(session('workspace'), core)

    expect(ensure).not.toHaveBeenCalled()
    expect(buildManifestText).not.toHaveBeenCalled()
    expect(prefix.workspaceRoot).toBe('/workspace')
    expect(prefix.items).toEqual([prefix.system, prefix.toolManifest, prefix.environment])
    expect(prefix.content).toBe(prefix.items.map((item) => item.content).join('\n'))
    expect(prefix.content).not.toContain('不应出现在稳定前缀的 skills 清单')
    expect(prefix).not.toHaveProperty('skillManifest')
  })
})
