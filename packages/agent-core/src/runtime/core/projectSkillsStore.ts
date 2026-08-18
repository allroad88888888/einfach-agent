// runtime/core/projectSkillsStore.ts —— CoreInstance 的项目 Skills 缓存 store。
// 快照存实例 rootStore 的 projectSkillsAtom（按 workspaceRoot 分桶），UI 可直接订阅；
// in-flight promise 用 Map 去重，不进 store（瞬态调度信息）。
// 扫描实现经 ProjectSkillsProvider 在装配期注入（B1 反转）：core 不再 import loader，
// 未注入 provider ＝ 该环境永远没有项目 skills，空快照即正确答案。

import type { Store } from '@einfach/core'
import type { ProjectSkillsSnapshot } from '../../skills/projectSkills'
import { emptyProjectSkillsSnapshot } from '../../skills/projectSkillsSnapshot'
import { projectSkillsAtom } from '../../state/rootAtoms'

/**
 * 项目 Skills 存储接口。
 * 缓存键 = workspaceRoot（非 sessionId），同 workspace 多会话共享一份快照。
 */
export interface ProjectSkillsStore {
  /** 取或建快照，命中缓存时同步返回；未注入 provider 时直接写入空快照。 */
  ensure(workspaceRoot: string): Promise<ProjectSkillsSnapshot>
  /** 强制重扫（无视缓存）。 */
  refresh(workspaceRoot: string): Promise<ProjectSkillsSnapshot>
  /** 装配期设置此实例的项目 Skills provider。 */
  setProvider(provider?: ProjectSkillsProvider): void
  /** 清空该 workspaceRoot 的缓存。 */
  clear(workspaceRoot: string): void
  /** 获取缓存中的快照（不触发扫描）。 */
  get(workspaceRoot: string): ProjectSkillsSnapshot | undefined
}

/**
 * tools-skills 的 project skill loader 依赖的文件系统桥接口。
 * 生产实现走 ToolContext 的 listWorkspaceFiles / readWorkspaceFile，
 * 测试 fake 此接口完成纯内存覆盖。
 */
export interface ProjectSkillsLoaderBridge {
  listFiles(path: string, options: {
    recursive: boolean
    includeHidden: boolean
    maxEntries: number
    workspaceRoot: string
    allowExternalPaths: boolean
  }): Promise<{ entries: Array<{ path: string; type: string }> }>
  readFile(path: string, options: {
    maxBytes: number
    workspaceRoot: string
    allowExternalPaths: boolean
  }): Promise<{ content: string }>
}

/** 项目 Skills 的注入槽：由装配层决定如何扫描某个 workspace。 */
export type ProjectSkillsProvider = (workspaceRoot: string) => Promise<ProjectSkillsSnapshot>

export function createProjectSkillsStore(
  rootStore: Store,
  initialProvider?: ProjectSkillsProvider,
): ProjectSkillsStore {
  let projectSkillsProvider = initialProvider
  const inFlight = new Map<string, Promise<ProjectSkillsSnapshot>>()
  const read = (workspaceRoot: string): ProjectSkillsSnapshot | undefined =>
    rootStore.getter(projectSkillsAtom)[workspaceRoot]
  const write = (snapshot: ProjectSkillsSnapshot): ProjectSkillsSnapshot => {
    rootStore.setter(projectSkillsAtom, {
      ...rootStore.getter(projectSkillsAtom),
      [snapshot.workspaceRoot]: snapshot,
    })
    return snapshot
  }

  const store: ProjectSkillsStore = {
    get(workspaceRoot) {
      return read(workspaceRoot)
    },
    async ensure(workspaceRoot) {
      const cached = read(workspaceRoot)
      if (cached) return cached
      // 同一 workspace 的并发 run 各自 ensure 时只扫一次：后来者复用同一个 in-flight promise。
      const pending = inFlight.get(workspaceRoot)
      if (pending) return pending
      return store.refresh(workspaceRoot)
    },
    async refresh(workspaceRoot) {
      const provider = projectSkillsProvider
      if (!provider) {
        return write(emptyProjectSkillsSnapshot(workspaceRoot))
      }

      const scan = (async () => {
        try {
          return write(await provider(workspaceRoot))
        } catch (error) {
          // 扫描器本身崩了（不是单个文件读失败——那些在 loader 内部已降级成 diagnostics）。
          // 绝不让它冒泡到 run：项目 skills 是增强，不是运行前提。
          const detail = error instanceof Error ? error.message : String(error)
          return write({
            workspaceRoot,
            entries: [],
            diagnostics: [`项目 skills 扫描失败，已降级为无项目 skills：${detail}`],
          })
        } finally {
          inFlight.delete(workspaceRoot)
        }
      })()
      inFlight.set(workspaceRoot, scan)
      return scan
    },
    setProvider(provider) {
      projectSkillsProvider = provider
    },
    clear(workspaceRoot) {
      const current = rootStore.getter(projectSkillsAtom)
      if (!(workspaceRoot in current)) return
      const next = { ...current }
      delete next[workspaceRoot]
      rootStore.setter(projectSkillsAtom, next)
    },
  }

  return store
}
