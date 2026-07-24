// D-3 · 启动 hydrate —— 从持久化恢复「会话列表 + 每会话 checkpoints/items」（§4 D-3 / DK1 / DK2）。
// ---------------------------------------------------------------------------
// 背景：DK1 持久化范围 = 会话列表（SessionMeta，走 sessions 存储）+ 每会话 checkpoints（走 HistoryDriver）。
//   启动时把两者读回内存 store：
//     · rootStore.sessionsAtom      ← 全部 SessionMeta（会话是否存在的权威登记表）
//     · rootStore.activeSessionId   ← updatedAt 最新的那个会话（默认落在最近用过的会话）
//     · 各会话 store.checkpointsAtom ← 该会话完整 Checkpoint 序列
//     · 各会话 store.itemsAtom       ← 最新一轮 checkpoint 的 items（刷新即恢复对话历史，DK1）
//     · 各会话 store.currentTurnIndex← 最新一轮 turnIndex（回退游标停在末轮）
//   写进登记表之前先过一道**下线模型名迁移**（./modelMigration）：settings.model 是持久化字段，
//   provider 下线旧模型名后，存量会话恢复出来一发请求就是 400；这里是唯一能一次覆盖全部存量会话的位置。
//   容错（DK2）：driver 全 async、启动异步回填、失败不阻塞 app —— loadSessions 抛错整体放弃恢复
//   （返回 false 让 main.tsx 去种子）；恢复过程中任何异常都吞掉、绝不上抛（沿用旧 hydrateFromStorage 语义）。
//   返回值 = 「是否恢复了会话」，供 main.tsx 决定要不要种子一个空会话（RF3：有数据就别再种子）。

import type { Checkpoint } from '../checkpoint.type'
import type { SessionMeta, WorkspaceMeta } from '../core.type'
import {
  rootStore,
  workspacesAtom,
  activeWorkspaceIdAtom,
  expandedWorkspaceIdsAtom,
  sessionsAtom,
  activeSessionIdAtom,
} from '../rootStore'
import { getSessionStore } from '../sessionStore'
import { checkpointsAtom, currentTurnIndexAtom, itemsAtom, planAtom } from '../sessionAtoms'
import type { HistoryDriver } from './historyDriver'
import { migrateSessionMeta } from './modelMigration'
import { migratePlanSnapshot } from '../../planning/migrate'
import { executionGraphAtom, reduceExecutionGraph } from '../../execution/graph'
import {
  DEFAULT_WORKSPACE_NAME,
  deriveWorkspaceName,
  normalizeWorkspaceRoot,
} from '../workspaceState'

function stableWorkspaceId(seed: string): string {
  let hash = 2166136261
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `workspace-${(hash >>> 0).toString(36)}`
}

function attachSessionsToWorkspaces(
  sessions: SessionMeta[],
  persistedWorkspaces: WorkspaceMeta[],
): { sessions: SessionMeta[]; workspaces: WorkspaceMeta[] } {
  const byId: Record<string, WorkspaceMeta> = Object.fromEntries(
    persistedWorkspaces.map((workspace) => [
      workspace.id,
      { ...workspace, rootPath: normalizeWorkspaceRoot(workspace.rootPath) },
    ]),
  )

  const findByRoot = (rootPath?: string) =>
    Object.values(byId).find((workspace) => workspace.rootPath === rootPath)

  const migratedSessions = sessions.map((session) => {
    const legacyRoot = normalizeWorkspaceRoot(session.workspaceRoot)
    let workspace = session.workspaceId ? byId[session.workspaceId] : undefined
    workspace ??= findByRoot(legacyRoot)

    if (!workspace) {
      const preferredId = session.workspaceId
        ?? stableWorkspaceId(legacyRoot ? `root:${legacyRoot}` : 'default')
      let id = preferredId
      let suffix = 1
      while (byId[id]) {
        id = `${preferredId}-${suffix}`
        suffix += 1
      }
      workspace = {
        id,
        name: legacyRoot ? deriveWorkspaceName(legacyRoot) : DEFAULT_WORKSPACE_NAME,
        rootPath: legacyRoot,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      }
      byId[id] = workspace
    } else if (!persistedWorkspaces.some((item) => item.id === workspace!.id)) {
      byId[workspace.id] = {
        ...workspace,
        createdAt: Math.min(workspace.createdAt, session.createdAt),
        updatedAt: Math.max(workspace.updatedAt, session.updatedAt),
      }
    }

    const { workspaceRoot: _legacyWorkspaceRoot, ...rest } = session
    return { ...rest, workspaceId: workspace.id }
  })

  return { sessions: migratedSessions, workspaces: Object.values(byId) }
}

// 简介：从持久化恢复会话列表与每会话历史，回填内存 store；返回是否恢复了任何会话。
// 详情：deps 注入 sessions（会话列表持久化，只读 loadSessions）+ history（HistoryDriver），
//   便于测试用内存实现。空/失败一律返回 false（让上层种子）；成功回填返回 true。
//   本函数【只读不写】盘——下线模型名迁移也只改内存，理由见下面 migrateSessionMeta 处的注释。
export async function hydrate(deps: {
  sessions: {
    loadSessions(): Promise<SessionMeta[]>
    loadWorkspaces?(): Promise<WorkspaceMeta[]>
  }
  history: HistoryDriver
}): Promise<boolean> {
  // 第一步：取会话列表。加载失败 → 放弃恢复、让 main.tsx 种子（容错，DK2）。
  let sessions: SessionMeta[]
  let workspaces: WorkspaceMeta[] = []
  try {
    sessions = await deps.sessions.loadSessions()
  } catch {
    return false
  }
  try {
    workspaces = await deps.sessions.loadWorkspaces?.() ?? []
  } catch {
    // 老版本或部分损坏的工作区存储不应拖垮仍然可恢复的会话；下面会从会话兼容字段重建。
    workspaces = []
  }

  // 工作区本身也是可持久化实体；只有两者都为空才需要启动种子。
  if (sessions.length === 0 && workspaces.length === 0) {
    return false
  }

  // 已确认有持久化会话：整体回填。任何异常都吞掉——sessions 非空即代表「盘上有会话、别再种子」，
  // 故即便中途失败也返回 true（RF3）。
  try {
    // 下线模型名迁移（modelMigration）：存量会话存的 settings.model 可能已被 provider 下线，
    // 恢复路径是唯一能一次覆盖全部存量会话的位置。无需迁移的会话原样返回同一引用。
    //
    // ★ 刻意【只迁内存、不回写盘】★ —— 这是「读时适配」而不是「写时改数据」：
    //   · loadSessions 的唯一调用点就是本函数（已全仓确认），不存在绕过 hydrate 直接读盘的路径，
    //     所以盘上留着旧名不影响任何行为——每次启动都会重迁一遍，且迁移幂等。
    //   · 盘上保留原始值是有价值的：映射表是照着 provider 公告手写的，万一填错（或 provider
    //     改了继任者），原始值还在就能重迁；一旦就地覆盖，用户当初选的模型名就永久丢失了。
    //     对不可逆的数据改写要保守。
    //   · 顺带消掉一类竞态：回写只能是 fire-and-forget（hydrate 的容错契约是「失败不阻塞启动」），
    //     而 saveSessions 是覆盖式落盘，与 persistenceBridge.persistSessions() 之间无顺序保证。
    //     若回写晚于「用户新建会话」落地，就会用不含新会话的旧列表整体覆盖掉它。
    const hydratedAt = Date.now()
    const modelMigratedSessions = sessions.map((session) => {
      const modelMigrated = migrateSessionMeta(session)
      if (!modelMigrated.executionGraph) return modelMigrated
      return {
        ...modelMigrated,
        executionGraph: reduceExecutionGraph(
          modelMigrated.executionGraph,
          { type: 'graph.hydrated', at: hydratedAt },
        ),
      }
    })
    const migrated = attachSessionsToWorkspaces(modelMigratedSessions, workspaces)
    const workspaceRecord = Object.fromEntries(
      migrated.workspaces.map((workspace) => [workspace.id, workspace]),
    )
    const latestSession = [...migrated.sessions].sort((a, b) => b.updatedAt - a.updatedAt)[0]
    const latestWorkspace = [...migrated.workspaces].sort((a, b) => b.updatedAt - a.updatedAt)[0]
    const activeWorkspaceId = latestSession?.workspaceId ?? latestWorkspace?.id ?? ''

    rootStore.setter(workspacesAtom, workspaceRecord)
    rootStore.setter(activeWorkspaceIdAtom, activeWorkspaceId)
    rootStore.setter(
      expandedWorkspaceIdsAtom,
      activeWorkspaceId ? { [activeWorkspaceId]: true } : {},
    )
    // 会话列表登记表：id → SessionMeta。
    rootStore.setter(
      sessionsAtom,
      Object.fromEntries(migrated.sessions.map((session) => [session.id, session])),
    )
    // active = updatedAt 最新（降序取头个）；不原地改入参，故先 [...] 拷贝再排序。
    rootStore.setter(activeSessionIdAtom, latestSession?.id ?? '')

    // 逐会话回填其完整 checkpoint 序列 + 最新一轮 items/游标。
    for (const session of migrated.sessions) {
      if (session.plan) getSessionStore(session.id).store.setter(planAtom, migratePlanSnapshot(session.plan))
      if (session.executionGraph) {
        getSessionStore(session.id).store.setter(executionGraphAtom, session.executionGraph)
      }
      const metas = await deps.history.listCheckpoints(session.id)
      if (metas.length === 0) {
        continue
      }

      // 按每条 meta 的 turnIndex 取回含 items 的完整 Checkpoint（loadCheckpoint 可能返回 undefined，滤掉）。
      const checkpoints: Checkpoint[] = []
      for (const meta of metas) {
        const cp = await deps.history.loadCheckpoint(session.id, meta.turnIndex)
        if (cp) {
          checkpoints.push(cp)
        }
      }
      if (checkpoints.length === 0) {
        continue
      }

      // 最新一轮 = turnIndex 最大的那条（不假设 metas 已按 turnIndex 排序）。
      const latest = checkpoints.reduce((a, b) => (b.turnIndex > a.turnIndex ? b : a))

      const store = getSessionStore(session.id).store
      store.setter(checkpointsAtom, checkpoints)
      store.setter(itemsAtom, latest.items)
      store.setter(currentTurnIndexAtom, latest.turnIndex)
    }

    return true
  } catch {
    // 恢复中途异常：sessions 已确认非空，仍算「有会话、别种子」→ 返回 true（DK2 不阻塞、不上抛）。
    return true
  }
}
