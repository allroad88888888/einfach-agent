import type { ProjectSkillsLoaderBridge, ProjectSkillsProvider } from '@einfach-agent/core'
import { emptyProjectSkillsSnapshot } from '@einfach-agent/core/skills'
import { scanProjectSkills } from './projectSkillsLoader'

/**
 * 组装项目 skill provider。
 *
 * workspace bridge 延迟至首次扫描才从根公开面加载；仅注册内置工具时不能提前缓存
 * runtime/commands，否则会让测试文件的精确 vi.mock 在提升前失效。
 *
 * 用户主目录同样惰性解析、且只解析一次：它在一次进程生命周期内不会变，而每次切换 workspace
 * 都会重新扫描——每次都去问一遍宿主纯属白费一次 IPC。解析失败/非 Tauri 时是 undefined，
 * 扫描方据此只扫工作区。
 */
export function buildProjectSkillsProvider(): ProjectSkillsProvider {
  let bridgePromise: Promise<ProjectSkillsLoaderBridge | undefined> | undefined
  let userSkillsRootPromise: Promise<string | undefined> | undefined

  const loadBridge = () => {
    bridgePromise ??= import('@einfach-agent/core').then(
      ({ buildProjectSkillsWorkspaceBridge }) => buildProjectSkillsWorkspaceBridge(),
    )
    return bridgePromise
  }

  const loadUserSkillsRoot = () => {
    userSkillsRootPromise ??= import('@einfach-agent/core').then(
      ({ resolveUserSkillsRoot }) => resolveUserSkillsRoot(),
    )
    return userSkillsRootPromise
  }

  return async (workspaceRoot) => {
    const bridge = await loadBridge()
    if (!bridge) return emptyProjectSkillsSnapshot(workspaceRoot)
    const userSkillsRoot = await loadUserSkillsRoot()
    return scanProjectSkills(workspaceRoot, bridge, { userSkillsRoot })
  }
}
