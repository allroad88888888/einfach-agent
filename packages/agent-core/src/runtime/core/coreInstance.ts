// 背景：root/session stores、工具注册表、abort registry、delegation capability 与 persistence 均为实例资源。
// 【破环】本模块只 import 叶子层：createStore（einfach）、createToolRegistry（tools/toolRegistry，
//   不是 tools/registry）、createToolEpochStore（runtime/toolEpochStore，只依赖 tools/*，不回指 core）。
//   它【绝不】import 那五个视图模块（rootStore/sessionStore/registry/
//   abortRegistry/scheduler），也【不再】import 任何具体工具或 tools/register —— 工具改由调用方经 opts.registerTools
//   注入（登记反转，见下）。视图模块反过来 import 本模块的 defaultCore，构成单向依赖（视图 → coreInstance），
//   无环。详见 tools/toolRegistry.ts 顶部注释。
//
// 【登记反转 · TSPLIT TS1】createCoreInstance 不再自动 registerStandardTools —— 那会把 core 焊死在
//   那 21 个具体工具上（core→tools 的唯一入边），挡住工具拆包。现在 core 只造【空】registry，装什么由
//   消费方决定：opts.registerTools?.(registry) 在构造时注入，或事后 core.tools.register(...)。默认实例
//   defaultCore 造出来是【无工具】的；app（main.tsx）与测试（test/setup.ts）各调一次
//   registerStandardTools(defaultCore.tools) 恢复"默认 21 工具"。于是 core 变无主张（可嵌任意工具集），
//   宿主能力（项目 skills 扫描等）同理经 opts 注入（B1）。
import { createStore, type History, type Store } from '@einfach/core'
import { createToolRegistry, type ToolRegistry } from '../../tools/toolRegistry'
// 注册簿走叶子模块、派发面只取类型：静态 import 一旦落到 ../timedDispatch，就会闭合
// coreInstance → timedDispatch → state/sessionWriters → state/rootStore → coreInstance，
// 而 rootStore 在模块顶层读 `defaultCore.rootStore`，环里读到的是 undefined。
import { createTimedToolRegistry, type TimedToolRegistration } from '../timedToolRegistry'
import type {
  TimedToolDispatchRequest,
  TimedToolDispatchResult,
} from '../timedDispatch'
import { createToolEpochStore, type ToolEpochStore } from '../toolEpochStore'
import type { DelegationCapability, DelegationRuntimeFactory } from '../delegationContract'
import { emptySkillsRegistry, type SkillsRegistry } from '../../skills/contracts'
import { createPluginHost, type PluginHost, type PluginInput } from './pluginHost'
import {
  createProjectSkillsStore,
  type ProjectSkillsProvider,
  type ProjectSkillsStore,
} from './projectSkillsStore'
import {
  createPersistenceBridge,
  setDefaultPersistenceBridge,
  type PersistenceBridge,
} from '../persistenceBridge'
import { createRuntimeConfig, type RuntimeConfig } from './runtimeConfig'
import type { PlanRuntimeFactory } from '../../planning/runtime'
import { getDefaultObservabilityPort, type ObservabilityPort } from '../../observability/port'
import { createAbortRegistry, type AbortRegistryLike } from './abortRegistryStore'
import { createSessionHistory } from '../../state/sessionHistory'

export type { RuntimeConfig } from './runtimeConfig'

// 单会话独立 store；由 sessionStore.ts re-export，避免 coreInstance 反向 import sessionStore 成环。
export interface SessionStore {
  id: string
  store: Store
  /**
   * 该会话的事务日志（undo/redo + 崩溃恢复的同一份记录）。
   *
   * 每个会话一本：`createHistory(store)` 是 per-store 的，而本仓「一个会话一个 store」，
   * 两者边界天然对齐。建 store 时就把 SESSION_SLOTS 的 applier 全部登记好 —— `record()`
   * 遇到未注册的 key 会失败，所以登记必须早于任何写入。
   */
  history: History
}

interface ActiveTimedToolDispatcher {
  runId: string
  isActive(): boolean
  dispatch(request: TimedToolDispatchRequest): Promise<TimedToolDispatchResult>
}

export type { AbortRegistryLike } from './abortRegistryStore'

// 项目 Skills 缓存 store 拆至 ./projectSkillsStore（B1）；此处 re-export 维持既有 import 面。
export type {
  ProjectSkillsLoaderBridge,
  ProjectSkillsProvider,
  ProjectSkillsStore,
} from './projectSkillsStore'

// 一个 CoreInstance 包含彼此隔离的 root/session stores、tools、abort、delegation、config、skills 与 persistence。
export interface CoreInstance {
  /** 此 Core 的观测出口；runtime 只能经此契约发射 trace。 */
  readonly observability: ObservabilityPort
  // 该实例的根 store：sessionsAtom/activeSessionIdAtom 的值域（会话列表 + 当前会话 id）。
  readonly rootStore: Store
  /** 仅查询当前实例中已存在的会话 store，绝不因查找分配新 store。 */
  findSessionStore(id: string): SessionStore | undefined
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
  // 按每个时机保留的注册顺序快照；到点分派不扫描完整工具目录。
  timedToolRegistrations(timing: TimedToolDispatchRequest['timing']): readonly TimedToolRegistration[]
  /** 宿主受限入口：必须明确指定会话；无活跃 run 时不执行，也不产生记账。 */
  dispatchTimedTools(request: TimedToolDispatchRequest): Promise<TimedToolDispatchResult>
  /** 仅由 loop 装卸当前 run 的分派器，返回的清理函数不会移除后继 run。 */
  bindTimedToolDispatcher(input: {
    sessionId: string
    runId: string
    isActive(): boolean
    dispatch(request: TimedToolDispatchRequest): Promise<TimedToolDispatchResult>
  }): () => void
  // 该实例私有的 run 级工具集 epoch：run 开始时冻结一份目录，暂停/恢复同一 runId 时复用。
  readonly toolEpochs: ToolEpochStore
  // 该实例私有的插件宿主；工具归 Core，hook/订阅归单次 run。
  readonly plugins: PluginHost
  // 该实例私有的 abort 注册表。
  readonly abort: AbortRegistryLike
  // 可选的子 Agent 委派能力；scheduler 的持有权属于这项 capability。
  // defaultCore 可由产品装配层在启动时注入，独立 core 则在 createCore 时显式传入。
  delegation: DelegationCapability | undefined
  // 该实例的运行时配置（apiKey 等）。引用只读，字段可改（供 configureCommands 覆盖）。
  readonly config: RuntimeConfig
  // 该实例的项目 Skills 缓存（per workspaceRoot，与 core.tools 同构）。
  readonly projectSkills: ProjectSkillsStore
  // 该实例装配的内置 skill registry；core 只消费契约，不持有实现。
  readonly skillRegistry: SkillsRegistry
  // 装配期设置此实例的内置 skill registry。
  setSkillRegistry(registry?: SkillsRegistry): void
  planRuntime?: PlanRuntimeFactory
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
  /** 由装配层提供的观测出口；未传时复用默认装配的静默 port。 */
  observability?: ObservabilityPort
  registerTools?: (registry: ToolRegistry) => void
  plugins?: readonly PluginInput[]
  projectSkillsProvider?: ProjectSkillsProvider
  skillRegistry?: SkillsRegistry
  planRuntime?: PlanRuntimeFactory | null
  /** 子 Agent 委派能力必须由产品装配层显式提供；null 与未传都表示未注入。 */
  delegation?: DelegationRuntimeFactory | null
}): CoreInstance {
  // 1) 根 store：该实例的会话列表值域。
  const rootStore = createStore()
  const observability = opts?.observability ?? getDefaultObservabilityPort()

  // 2) per-session store 缓存：本实例私有 Map（逻辑照搬原 sessionStore.ts，Map 从模块级变实例字段）。
  const sessionStores = new Map<string, SessionStore>()

  function createSessionStore(id: string): SessionStore {
    // 每次调用都建新 store——已存在同 id 会被覆盖（drop 后重建即走这条路）。
    const store = createStore()
    const history = createSessionHistory(store)
    const sessionStore: SessionStore = { id, store, history }
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

  function findSessionStore(id: string): SessionStore | undefined {
    return sessionStores.get(id)
  }

  const persistence = createPersistenceBridge(
    rootStore,
    observability,
    (sessionId) => getSessionStore(sessionId).store,
  )

  function dropSessionStore(id: string): void {
    sessionStores.delete(id)
    timedDispatchers.delete(id)
    // 会话没了，它那份 run 工具集 epoch 也没有任何消费者了。
    toolEpochs.release(id)
  }

  function resetSessionStores(): void {
    sessionStores.clear()
    timedDispatchers.clear()
    toolEpochs.reset()
  }

  // 3) 工具注册表：本实例私有 registry。【登记反转】不再自动装标准工具——由 opts.registerTools
  //    在此注入（未传则留空，消费方事后自行 register；见文件头 TS1 注释）。
  const timedRegistry = createTimedToolRegistry(createToolRegistry())
  const { tools } = timedRegistry
  opts?.registerTools?.(tools)
  const plugins = createPluginHost(tools, opts?.plugins)
  // 3.1) run 级工具集 epoch 的归属：跟 registry 一样是实例私有的，两个 core 互不可见。
  const toolEpochs = createToolEpochStore(tools)

  // 4) abort 注册表：本实例私有 Map。
  const abort = createAbortRegistry()

  // 5) 委派能力：core 不内置产品实现，只有装配层显式 factory 才会创建 capability。
  const delegation = opts?.delegation?.()

  // 6) 运行时配置：默认空 key，opts.config 浅合并覆盖。
  const config = createRuntimeConfig(opts?.config)

  // 7) 项目 Skills 缓存：实现在 ./projectSkillsStore；扫描 provider 经 opts 注入（B1 反转）。
  const projectSkills = createProjectSkillsStore(rootStore, opts?.projectSkillsProvider)
  let skillRegistry = opts?.skillRegistry ?? emptySkillsRegistry
  const planRuntime = opts?.planRuntime ?? undefined
  const timedDispatchers = new Map<string, ActiveTimedToolDispatcher>()

  function setSkillRegistry(registry?: SkillsRegistry): void {
    skillRegistry = registry ?? emptySkillsRegistry
  }

  async function dispatchTimedTools(request: TimedToolDispatchRequest): Promise<TimedToolDispatchResult> {
    const dispatcher = timedDispatchers.get(request.sessionId)
    if (!dispatcher?.isActive()) return { status: 'no_active_run', itemCount: 0 }
    return dispatcher.dispatch(request)
  }

  function bindTimedToolDispatcher(input: {
    sessionId: string
    runId: string
    isActive(): boolean
    dispatch(request: TimedToolDispatchRequest): Promise<TimedToolDispatchResult>
  }): () => void {
    const dispatcher: ActiveTimedToolDispatcher = {
      runId: input.runId,
      isActive: input.isActive,
      dispatch: input.dispatch,
    }
    timedDispatchers.set(input.sessionId, dispatcher)
    return () => {
      if (timedDispatchers.get(input.sessionId) === dispatcher) timedDispatchers.delete(input.sessionId)
    }
  }

  return {
    observability,
    rootStore,
    findSessionStore,
    getSessionStore,
    createSessionStore,
    dropSessionStore,
    resetSessionStores,
    tools,
    timedToolRegistrations: timedRegistry.registrations,
    dispatchTimedTools,
    bindTimedToolDispatcher,
    toolEpochs,
    plugins,
    abort,
    delegation,
    config,
    projectSkills,
    get skillRegistry() {
      return skillRegistry
    },
    setSkillRegistry,
    planRuntime,
    persistence,
  }
}

// 全局默认实例：五个视图模块（rootStore/sessionStore/registry/abortRegistry/scheduler）都取自它。
// 首次求值即创建——任一视图模块被 import 时触发。【登记反转】它造出来是【无工具】的：
// app（main.tsx）与测试（test/setup.ts）负责调 registerStandardTools(defaultCore.tools) 装标准工具。
export const defaultCore: CoreInstance = createCoreInstance({
  observability: getDefaultObservabilityPort(),
})
setDefaultPersistenceBridge(defaultCore.persistence)

/** 为模块级 defaultCore 注入项目 Skills provider；仅供应用装配期调用。 */
export function configureDefaultProjectSkillsProvider(provider?: ProjectSkillsProvider): void {
  defaultCore.projectSkills.setProvider(provider)
}

/** 为模块级 defaultCore 注入内置 skill registry；仅供应用装配期调用。 */
export function configureDefaultSkillsRegistry(registry?: SkillsRegistry): void {
  defaultCore.setSkillRegistry(registry)
}

/** 为模块级 defaultCore 注入子 Agent 委派能力；仅供产品装配期调用。 */
export function configureDefaultDelegation(factory?: DelegationRuntimeFactory | null): void {
  defaultCore.delegation = factory?.()
}
