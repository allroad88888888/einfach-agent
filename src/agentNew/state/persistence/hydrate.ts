// D-3 · 启动 hydrate —— 从持久化恢复「会话列表 + 每会话 checkpoints/items」（§4 D-3 / DK1 / DK2）。
// ---------------------------------------------------------------------------
// 背景：DK1 持久化范围 = 会话列表（SessionMeta，走 sessions 存储）+ 每会话 checkpoints（走 HistoryDriver）。
//   启动时把两者读回内存 store：
//     · rootStore.sessionsAtom      ← 全部 SessionMeta（会话是否存在的权威登记表）
//     · rootStore.activeSessionId   ← updatedAt 最新的那个会话（默认落在最近用过的会话）
//     · 各会话 store.checkpointsAtom ← 该会话完整 Checkpoint 序列
//     · 各会话 store.itemsAtom       ← 最新一轮 checkpoint 的 items（刷新即恢复对话历史，DK1）
//     · 各会话 store.currentTurnIndex← 最新一轮 turnIndex（回退游标停在末轮）
//   容错（DK2）：driver 全 async、启动异步回填、失败不阻塞 app —— loadSessions 抛错整体放弃恢复
//   （返回 false 让 main.tsx 去种子）；恢复过程中任何异常都吞掉、绝不上抛（沿用旧 hydrateFromStorage 语义）。
//   返回值 = 「是否恢复了会话」，供 main.tsx 决定要不要种子一个空会话（RF3：有数据就别再种子）。

import type { Checkpoint } from '../checkpoint.type'
import type { SessionMeta } from '../core.type'
import { rootStore, sessionsAtom, activeSessionIdAtom } from '../rootStore'
import { getSessionStore } from '../sessionStore'
import { checkpointsAtom, currentTurnIndexAtom, itemsAtom } from '../sessionAtoms'
import type { HistoryDriver } from './historyDriver'

// 简介：从持久化恢复会话列表与每会话历史，回填内存 store；返回是否恢复了任何会话。
// 详情：deps 注入 sessions（会话列表持久化，只用到 loadSessions）+ history（HistoryDriver），
//   便于测试用内存实现。空/失败一律返回 false（让上层种子）；成功回填返回 true。
export async function hydrate(deps: {
  sessions: { loadSessions(): Promise<SessionMeta[]> }
  history: HistoryDriver
}): Promise<boolean> {
  // 第一步：取会话列表。加载失败 → 放弃恢复、让 main.tsx 种子（容错，DK2）。
  let sessions: SessionMeta[]
  try {
    sessions = await deps.sessions.loadSessions()
  } catch {
    return false
  }

  // 无持久化会话 → 返回 false，由 main.tsx 种子一个空会话。
  if (sessions.length === 0) {
    return false
  }

  // 已确认有持久化会话：整体回填。任何异常都吞掉——sessions 非空即代表「盘上有会话、别再种子」，
  // 故即便中途失败也返回 true（RF3）。
  try {
    // 会话列表登记表：id → SessionMeta。
    rootStore.setter(sessionsAtom, Object.fromEntries(sessions.map((s) => [s.id, s])))
    // active = updatedAt 最新（降序取头个）；不原地改入参，故先 [...] 拷贝再排序。
    rootStore.setter(
      activeSessionIdAtom,
      [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)[0].id,
    )

    // 逐会话回填其完整 checkpoint 序列 + 最新一轮 items/游标。
    for (const session of sessions) {
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
