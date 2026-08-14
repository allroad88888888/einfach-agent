import type { ProjectSkillsLoaderBridge, ProjectSkillsProvider } from '@web-agent/core'
import { emptyProjectSkillsSnapshot } from '@web-agent/core/skills'
import { scanProjectSkills } from './projectSkillsLoader'

/**
 * 组装项目 skill provider。
 *
 * workspace bridge 延迟至首次扫描才从根公开面加载；仅注册内置工具时不能提前缓存
 * runtime/commands，否则会让测试文件的精确 vi.mock 在提升前失效。
 */
export function buildProjectSkillsProvider(): ProjectSkillsProvider {
  let bridgePromise: Promise<ProjectSkillsLoaderBridge | undefined> | undefined

  const loadBridge = () => {
    bridgePromise ??= import('@web-agent/core').then(
      ({ buildProjectSkillsWorkspaceBridge }) => buildProjectSkillsWorkspaceBridge(),
    )
    return bridgePromise
  }

  return async (workspaceRoot) => {
    const bridge = await loadBridge()
    return bridge
      ? scanProjectSkills(workspaceRoot, bridge)
      : emptyProjectSkillsSnapshot(workspaceRoot)
  }
}
