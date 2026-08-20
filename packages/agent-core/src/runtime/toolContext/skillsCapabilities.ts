// runtime/toolContext/skillsCapabilities.ts —— ctx 上的 Skills 只读入口（内置 + 扫描来的）。
// 扫描快照在 ctx 构造期取一次并按会话禁用列表过滤；workspaceRoot 为空时降级为仅内置。
// 这里**只读缓存、不触发扫描**：扫描由 buildStableModelPrefix 组 L1 清单时 ensure 一次（C7），
// 工具跑起来时快照必然已在。曾经还有一个 `ensure()` 入口，那是给已删除的 skill_manifest 到点工具
// 用的，随它一起去掉——留着就是一条没有调用方的扫描通路。
// resolveScannedSkill 只按名字查扫描期生成的白名单，绝不用模型给的字符串拼路径——这是 L3 资源
// 没有穿越面的原因。

import type { ToolContext } from '../../tools/types'
import { disabledProjectSkillsByWorkspaceAtom, sessionsAtom } from '../../state/rootStore'
import { filterProjectSkillsSnapshot } from '../../skills/projectSkillPreferences'
import { skillScopeFromName } from '../../skills/projectSkills'
import { sessionDisabledProjectSkills } from '../../state/workspaceState'
import type { CoreInstance } from '../core/coreInstance'

export type SkillsCapabilities = Pick<ToolContext, 'skills'>

export function createSkillsCapabilities(deps: {
  sessionId: string
  core: CoreInstance
  workspaceRoot: string | undefined
}): SkillsCapabilities {
  const { sessionId, core, workspaceRoot } = deps

  // Skills 只读入口：合并内置 + 项目快照（workspaceRoot 为空时降级为仅内置）。
  // 停用名单与 L1 清单读同一个判据（sessionDisabledProjectSkills），否则会出现
  // 「清单里没有、skill_read 却读得到」这种两边不一致。
  const disabledProjectSkills = sessionDisabledProjectSkills(
    core.rootStore.getter(sessionsAtom)[sessionId],
    core.rootStore.getter(disabledProjectSkillsByWorkspaceAtom),
  )
  const projectSkillsSnapshot = workspaceRoot
    ? filterProjectSkillsSnapshot(core.projectSkills.get(workspaceRoot), disabledProjectSkills)
    : undefined

  return {
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
      resolveScannedSkill(name) {
        if (!projectSkillsSnapshot || !skillScopeFromName(name)) return undefined
        const entry = projectSkillsSnapshot.entries.find((candidate) => candidate.name === name)
        if (!entry) return undefined
        // 根跟着条目走（工作区 / 主目录 / 被链接进来的那个目录），读取方原样转交给桥。
        return { filePath: entry.filePath, resources: entry.resources, rootPath: entry.rootPath }
      },
    },
  }
}
