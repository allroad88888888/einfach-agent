// runtime/toolContext/skillsCapabilities.ts —— ctx 上的 Skills 只读入口（内置 + 项目）。
// 项目快照在 ctx 构造期取一次并按会话禁用列表过滤；workspaceRoot 为空时降级为仅内置，
// projectSkills 整个能力缺席。resolveProjectPath 只按名字查扫描期生成的白名单，绝不用模型给的
// 字符串拼路径——这是 L3 资源没有穿越面的原因。逐字沿用拆分前 buildToolContext 里的实现。

import type { ToolContext } from '../../tools/types'
import { disabledProjectSkillsByWorkspaceAtom, sessionsAtom } from '../../state/rootStore'
import { filterProjectSkillsSnapshot } from '../../skills/projectSkillPreferences'
import type { CoreInstance } from '../core/coreInstance'

export type SkillsCapabilities = Pick<ToolContext, 'skills' | 'projectSkills'>

export function createSkillsCapabilities(deps: {
  sessionId: string
  core: CoreInstance
  workspaceRoot: string | undefined
}): SkillsCapabilities {
  const { sessionId, core, workspaceRoot } = deps

  // Skills 只读入口：合并内置 + 项目快照（workspaceRoot 为空时降级为仅内置）。
  const workspaceId = core.rootStore.getter(sessionsAtom)[sessionId]?.workspaceId
  const disabledProjectSkills = workspaceId
    ? core.rootStore.getter(disabledProjectSkillsByWorkspaceAtom)[workspaceId]
    : undefined
  const projectSkillsSnapshot = workspaceRoot
    ? filterProjectSkillsSnapshot(core.projectSkills.get(workspaceRoot), disabledProjectSkills)
    : undefined

  return {
    ...(workspaceRoot ? {
      projectSkills: {
        ensure: async () => filterProjectSkillsSnapshot(
          await core.projectSkills.ensure(workspaceRoot),
          disabledProjectSkills,
        )!,
      },
    } : {}),

    skills: {
      list() {
        const builtins = core.skillRegistry.list().map((s) => ({ ...s }))
        if (!projectSkillsSnapshot || projectSkillsSnapshot.entries.length === 0) return builtins
        const projects: Array<{ name: string; description: string; triggers: string[] }> =
          projectSkillsSnapshot.entries.map((e) => ({
            name: e.name,
            description: e.description,
            triggers: e.triggers,
          }))
        return [...builtins, ...projects]
      },
      resolveProjectPath(name) {
        if (!projectSkillsSnapshot || !name.startsWith('project/')) return undefined
        const entry = projectSkillsSnapshot.entries.find((candidate) => candidate.name === name)
        if (!entry) return undefined
        return { filePath: entry.filePath, resources: entry.resources }
      },
    },
  }
}
