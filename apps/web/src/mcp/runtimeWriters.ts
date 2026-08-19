import type { Store } from '@einfach/core'
import type { McpServerSnapshot, McpServerStatus } from '@einfach-agent/tools-mcp'
import {
  mcpServerConfigsAtom,
  mcpServerOperationsAtom,
  mcpServerRuntimeAtom,
} from './state'
import type { McpServerOperation } from './types'

/**
 * MCP 服务的【运行态怎么落到 UI atoms】：连接状态、工具数、错误文案，以及卡片上
 * 正在进行的那一步操作。
 *
 * 从 service.ts 拆出来是因为这是一层纯投影——它不决定什么时候连、什么时候存，
 * 只把「manager 说服务现在是这样」翻译成界面读得到的状态。service 那边留下的是编排。
 */

/** 任何来源的错误都要变成一句用户看得懂的中文，绝不把 undefined 写进卡片。 */
export function messageFromError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  if (typeof error === 'string' && error.trim()) return error
  return '未知错误'
}

function snapshotError(snapshot: McpServerSnapshot): string | undefined {
  const error: unknown = snapshot.error
  return error === undefined ? undefined : messageFromError(error)
}

export interface McpRuntimeWriters {
  /** 卡片上正在进行的操作；传 undefined 表示这一步结束了。 */
  setOperation(id: string, operation?: McpServerOperation): void
  setRuntime(
    id: string,
    status: McpServerStatus,
    toolCount?: number,
    error?: string,
  ): void
  applySnapshot(snapshot: McpServerSnapshot): void
  /** 批量应用；【只认已配置的服务】，manager 里的其它记录不该凭空长出卡片。 */
  applySnapshots(snapshots: readonly McpServerSnapshot[]): void
}

export function createMcpRuntimeWriters(store: Store): McpRuntimeWriters {
  const setRuntime = (
    id: string,
    status: McpServerStatus,
    toolCount = 0,
    error?: string,
  ): void => {
    store.setter(mcpServerRuntimeAtom, (previous) => ({
      ...previous,
      [id]: { status, toolCount, ...(error ? { error } : {}) },
    }))
  }

  const applySnapshot = (snapshot: McpServerSnapshot): void => {
    setRuntime(snapshot.id, snapshot.status, snapshot.tools.length, snapshotError(snapshot))
  }

  return {
    setOperation(id, operation) {
      store.setter(mcpServerOperationsAtom, (previous) => {
        const next = { ...previous }
        if (operation) next[id] = operation
        else delete next[id]
        return next
      })
    },
    setRuntime,
    applySnapshot,
    applySnapshots(snapshots) {
      const configuredIds = new Set(
        store.getter(mcpServerConfigsAtom).map((config) => config.id),
      )
      for (const snapshot of snapshots) {
        if (configuredIds.has(snapshot.id)) applySnapshot(snapshot)
      }
    },
  }
}
