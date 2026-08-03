// runtime/core/coreInstance.ts —— 「实例化」的地基：把六类模块级资源收进一个 CoreInstance。
// ---------------------------------------------------------------------------
// 背景：现状是六类各自为政的模块资源——
//   · state/rootStore.ts      的 rootStore（会话列表 store）
//   · state/sessionStore.ts   的 per-session store 缓存 Map
//   · tools/registry.ts       的 toolRegistry（工具注册表）
//   · runtime/abortRegistry.ts 的 controllers Map（每会话 AbortController）
//   · subagents/scheduler.ts  的任务树与订阅者（子 agent 调度状态）
//   · runtime/persistenceBridge.ts 的 driver、写队列与 rootStore 快照
// 本模块把这六类资源收进一个 CoreInstance 抽象，并造 `defaultCore = createCoreInstance()`
// 把它们实例化一次。上面六个模块随后【全部改写成 defaultCore 的视图】——照旧导出同名符号，
// 只是背后取自 defaultCore。对所有调用点完全透明（本期不穿线到 runtime，行为零变化）。
//
// 【破环】本模块只 import 叶子层：createStore（einfach）、createToolRegistry（tools/toolRegistry，
//   不是 tools/registry）。它【绝不】import 那五个视图模块（rootStore/sessionStore/registry/
//   abortRegistry/scheduler），也【不再】import 任何具体工具或 tools/register —— 工具改由调用方经 opts.registerTools
//   注入（登记反转，见下）。视图模块反过来 import 本模块的 defaultCore，构成单向依赖（视图 → coreInstance），
//   无环。详见 tools/toolRegistry.ts 顶部注释。
//
// 【登记反转 · TSPLIT TS1】createCoreInstance 不再自动 registerStandardTools —— 那会把 core 焊死在
//   那 21 个具体工具上（core→tools 的唯一入边），挡住工具拆包。现在 core 只造【空】registry，装什么由
//   消费方决定：opts.registerTools?.(registry) 在构造时注入，或事后 core.tools.register(...)。默认实例
//   defaultCore 造出来是【无工具】的；app（main.tsx）与测试（test/setup.ts）各调一次
//   registerStandardTools(defaultCore.tools) 恢复"默认 21 工具"。于是 core 变无主张（可嵌任意工具集），
//   batteries-included 由消费层一行恢复。
import { createStore, type Store } from '@einfach/core'
import { createToolRegistry, type ToolRegistry } from '../../tools/toolRegistry'
import { createSubagentScheduler, type SubagentScheduler } from '../../subagents/schedulerState'
import type { ProjectSkillsSnapshot } from '../../skills/projectSkills'
import { emptyProjectSkillsSnapshot } from '../../skills/projectSkills'
import {
  createPersistenceBridge,
  setDefaultPersistenceBridge,
  type PersistenceBridge,
} from '../persistenceBridge'
// rootAtoms 是零 runtime 依赖的叶子层（破环地基），coreInstance 可以安全引用它的 atom 定义。
import { projectSkillsAtom } from '../../state/rootAtoms'

// 单会话独立 store 的形状（对齐原 sessionStore.ts 的 SessionStore；本轮先不放 undo）。
// 定义放这里、由 sessionStore.ts re-export，避免 coreInstance 反向 import sessionStore 成环。
export interface SessionStore {
  id: string
  store: Store
}

// 每会话一个 AbortController 的注册表接口（对齐原 abortRegistry.ts 的导出函数集）。
// beginRun/abortRun/endRun/isRunning 语义与旧模块逐字一致；reset 供测试清场（= resetAbortRegistry）。
export interface AbortRegistryLike {
  beginRun(id: string): AbortSignal
  abortRun(id: string): void
  endRun(id: string, signal: AbortSignal): void
  isRunning(id: string): boolean
  reset(): void
}

/**
 * 项目 Skills 存储接口。
 * 缓存键 = workspaceRoot（非 sessionId），同 workspace 多会话共享一份快照。
 */
export interface ProjectSkillsStore {
  /** 取或建快照，命中缓存时同步返回，否则走 bridge 扫描（传 undefined 则直接空快照）。 */
  ensure(workspaceRoot: string, bridge?: ProjectSkillsLoaderBridge): Promise<ProjectSkillsSnapshot>
  /** 强制重扫（无视缓存）。 */
  refresh(workspaceRoot: string, bridge?: ProjectSkillsLoaderBridge): Promise<ProjectSkillsSnapshot>
  /** 清空该 workspaceRoot 的缓存。 */
  clear(workspaceRoot: string): void
  /** 获取缓存中的快照（不触发扫描）。 */
  get(workspaceRoot: string): ProjectSkillsSnapshot | undefined
}

/**
 * projectSkillsLoader 依赖的文件系统桥接口。
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

// 运行时配置（apiKey 等）。形状对齐 commands.ts 的运行时配置。
// 【第 2 期 · config 通电】defaultCore.config 已是第五个「视图」：configureCommands 现在【就地写它】
//   （Object.assign，不替换引用），命令读 apiKey/fetchImpl 也走 core.config —— 不再只是占位形状。
export interface RuntimeConfig {
  deepseekApiKey: string
  deepseekUserId?: string
  glmApiKey: string
  customInstructions: string
  fetchImpl?: typeof fetch
}

// 一个 CoreInstance 包含彼此隔离的 root/session stores、tools、abort、scheduler、config、skills 与 persistence。
export interface CoreInstance {
  // 该实例的根 store：sessionsAtom/activeSessionIdAtom 的值域（会话列表 + 当前会话 id）。
  readonly rootStore: Store
  // 该实例私有的 per-session store 缓存：取或建（幂等，同 id 同实例）。
  getSessionStore(id: string): SessionStore
  // 直接建新实例并写入缓存（同 id 覆盖，drop 后重建走这条）。
  createSessionStore(id: string): SessionStore
  // 关闭会话时丢弃其 store（后续 get 会重建）。
  dropSessionStore(id: string): void
  // 仅测试用：清空全部缓存的 store。
  resetSessionStores(): void
  // 该实例私有的工具注册表（登记反转后默认为空；由 opts.registerTools 或事后 register 填充）。
  readonly tools: ToolRegistry
  // 该实例私有的 abort 注册表。
  readonly abort: AbortRegistryLike
  // 该实例私有的子 agent 调度器。
  readonly subagentScheduler: SubagentScheduler
  // 该实例的运行时配置（apiKey 等）。引用只读，字段可改（供 configureCommands 覆盖）。
  readonly config: RuntimeConfig
  // 该实例的项目 Skills 缓存（per workspaceRoot，与 core.tools 同构）。
  readonly projectSkills: ProjectSkillsStore
  // 该实例的持久化 driver、写队列与 rootStore 快照。
  readonly persistence: PersistenceBridge
}

/**
 * 造一个全新的、与其它实例完全隔离的 CoreInstance。
 * opts.config 可预置 apiKey 等（浅合并进默认值）；opts.registerTools 在构造时把工具装进本实例私有 registry
 * （登记反转：core 不再硬编码标准工具，装什么由调用方决定）。
 *
 * 隔离性来自「每样都是本次调用私有的闭包/实例」：rootStore 独立 createStore()、
 * sessionStores 独立 Map、tools 独立 createToolRegistry()、controllers 独立 Map。
 * 两次 createCoreInstance 之间互不影响（见 coreInstance.test.ts）。
 */
export function createCoreInstance(opts?: {
  config?: Partial<RuntimeConfig>
  registerTools?: (registry: ToolRegistry) => void
}): CoreInstance {
  // 1) 根 store：该实例的会话列表值域。
  const rootStore = createStore()
  const persistence = createPersistenceBridge(rootStore)

  // 2) per-session store 缓存：本实例私有 Map（逻辑照搬原 sessionStore.ts，Map 从模块级变实例字段）。
  const sessionStores = new Map<string, SessionStore>()

  function createSessionStore(id: string): SessionStore {
    // 每次调用都建新 store——已存在同 id 会被覆盖（drop 后重建即走这条路）。
    const sessionStore: SessionStore = { id, store: createStore() }
    sessionStores.set(id, sessionStore)
    return sessionStore
  }

  function getSessionStore(id: string): SessionStore {
    // Map 命中则返回（幂等，同 id 同实例）；未命中则按需创建。
    const existing = sessionStores.get(id)
    if (existing) {
      return existing
    }
    return createSessionStore(id)
  }

  function dropSessionStore(id: string): void {
    sessionStores.delete(id)
  }

  function resetSessionStores(): void {
    sessionStores.clear()
  }

  // 3) 工具注册表：本实例私有 registry。【登记反转】不再自动装标准工具——由 opts.registerTools
  //    在此注入（未传则留空，消费方事后自行 register；见文件头 TS1 注释）。
  const tools = createToolRegistry()
  opts?.registerTools?.(tools)

  // 4) abort 注册表：本实例私有 Map（逻辑照搬原 abortRegistry.ts，Map 从模块级变实例字段）。
  const controllers = new Map<string, AbortController>()
  const abort: AbortRegistryLike = {
    beginRun(id) {
      // 起一个 run：若该 id 已有 controller，先 abort 旧的（新 run 顶掉旧 run），再登记全新 controller。
      const prev = controllers.get(id)
      if (prev) {
        prev.abort()
      }
      const controller = new AbortController()
      controllers.set(id, controller)
      return controller.signal
    },
    abortRun(id) {
      // 中断该 id 正在跑的 run：abort 并从 Map 删除；无则 no-op。
      const controller = controllers.get(id)
      if (!controller) return
      controller.abort()
      controllers.delete(id)
    },
    endRun(id, signal) {
      // 仅当 Map 里该 id 当前 controller 的 signal 就是传入 signal 时才 delete，
      // 避免被顶掉的旧 run（signal 已换）在 finally 里清掉新 run 的 controller。
      const controller = controllers.get(id)
      if (controller && controller.signal === signal) {
        controllers.delete(id)
      }
    },
    isRunning(id) {
      return controllers.has(id)
    },
    reset() {
      controllers.clear()
    },
  }

  // 5) 子 agent 调度器：调度树和观察者均只归属这个 core。
  const subagentScheduler = createSubagentScheduler()

  // 6) 运行时配置：默认空 key，opts.config 浅合并覆盖。
  const config: RuntimeConfig = {
    deepseekApiKey: '',
    glmApiKey: '',
    customInstructions: '',
    ...opts?.config,
  }

  // 7) 项目 Skills 缓存：快照存本实例 rootStore 的 projectSkillsAtom（按 workspaceRoot 分桶），
  //    UI 因此可以直接订阅；in-flight promise 另用 Map 去重，不进 store（它是瞬态调度信息）。
  const projectSkillsInFlight = new Map<string, Promise<ProjectSkillsSnapshot>>()
  const readProjectSkills = (workspaceRoot: string): ProjectSkillsSnapshot | undefined =>
    rootStore.getter(projectSkillsAtom)[workspaceRoot]
  const writeProjectSkills = (snapshot: ProjectSkillsSnapshot): ProjectSkillsSnapshot => {
    rootStore.setter(projectSkillsAtom, {
      ...rootStore.getter(projectSkillsAtom),
      [snapshot.workspaceRoot]: snapshot,
    })
    return snapshot
  }
  const projectSkills: ProjectSkillsStore = {
    get(workspaceRoot) {
      return readProjectSkills(workspaceRoot)
    },
    async ensure(workspaceRoot, bridge) {
      const cached = readProjectSkills(workspaceRoot)
      if (cached) return cached
      // 同一 workspace 的并发 run 各自 ensure 时只扫一次：后来者复用同一个 in-flight promise。
      const inFlight = projectSkillsInFlight.get(workspaceRoot)
      if (inFlight) return inFlight
      return projectSkills.refresh(workspaceRoot, bridge)
    },
    async refresh(workspaceRoot, bridge) {
      // 无 bridge（web 端非 Tauri）＝ 这个环境永远没有项目 skills，空快照即正确答案。
      if (!bridge) return writeProjectSkills(emptyProjectSkillsSnapshot(workspaceRoot))

      const scan = (async () => {
        try {
          const { scanProjectSkills } = await import('../../skills/projectSkillsLoader')
          return writeProjectSkills(await scanProjectSkills(workspaceRoot, bridge))
        } catch (error) {
          // 扫描器本身崩了（不是单个文件读失败——那些在 loader 内部已降级成 diagnostics）。
          // 绝不让它冒泡到 run：项目 skills 是增强，不是运行前提。
          const detail = error instanceof Error ? error.message : String(error)
          return writeProjectSkills({
            workspaceRoot,
            entries: [],
            diagnostics: [`项目 skills 扫描失败，已降级为无项目 skills：${detail}`],
          })
        } finally {
          projectSkillsInFlight.delete(workspaceRoot)
        }
      })()
      projectSkillsInFlight.set(workspaceRoot, scan)
      return scan
    },
    clear(workspaceRoot) {
      const current = rootStore.getter(projectSkillsAtom)
      if (!(workspaceRoot in current)) return
      const next = { ...current }
      delete next[workspaceRoot]
      rootStore.setter(projectSkillsAtom, next)
    },
  }

  return {
    rootStore,
    getSessionStore,
    createSessionStore,
    dropSessionStore,
    resetSessionStores,
    tools,
    abort,
    subagentScheduler,
    config,
    projectSkills,
    persistence,
  }
}

// 全局默认实例：五个视图模块（rootStore/sessionStore/registry/abortRegistry/scheduler）都取自它。
// 首次求值即创建——任一视图模块被 import 时触发。【登记反转】它造出来是【无工具】的：
// app（main.tsx）与测试（test/setup.ts）负责调 registerStandardTools(defaultCore.tools) 装标准工具。
export const defaultCore: CoreInstance = createCoreInstance()
setDefaultPersistenceBridge(defaultCore.persistence)
