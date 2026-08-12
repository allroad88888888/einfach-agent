import { emptyProjectSkillsSnapshot } from '@web-agent/core/skills/projectSkills'
import type {
  ProjectSkillsLoaderBridge,
  ProjectSkillsProvider,
} from '@web-agent/core/runtime/core/coreInstance'
import { scanProjectSkills } from './projectSkillsLoader'

/**
 * 组装项目 skill provider。
 *
 * workspace bridge 延迟至首次扫描再加载，避免仅注册内置工具时提前载入
 * Tauri 文件 API；这也让各运行时能在调用前完成自己的 Tauri 装配。
 */
export function buildProjectSkillsProvider(): ProjectSkillsProvider {
  let bridgePromise: Promise<ProjectSkillsLoaderBridge | undefined> | undefined

  const loadBridge = () => {
    bridgePromise ??= import('@web-agent/core/runtime/projectSkillsBridge').then(
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
