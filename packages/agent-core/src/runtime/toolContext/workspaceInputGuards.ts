// runtime/toolContext/workspaceInputGuards.ts —— 把 workspace 边界注入工具入参（S4-A）。
// 这是 workspace confinement 的入参侧：会话根目录注入、跨 workspace 只读权限的**唯一**来源、
// 变更审计上下文、shell cwd 兜底。四个装饰器逐字沿用拆分前 buildToolContext 里的内联实现——
// 尤其是 `allowExternalPaths` 必须先被剥掉再由 runtime 决定，避免模型伪造 runtime-only 权限。

import type { ShellCommandInput } from '../../tools/types'
import { sessionsAtom, workspacesAtom } from '../../state/rootStore'
import { resolveSessionWorkspaceRoot } from '../../state/workspaceState'
import type { CoreInstance } from '../core/coreInstance'
import { newId } from '../newId'

// S4-A：取该会话绑定的 workspace 根目录（去空白；未设置/空串 → undefined，桥不传 → Rust 走 git root 兜底）。
// 【实例化第 2 期】读会话登记表走 core.rootStore（core 无默认值，由 buildToolContext 传入）。
export function resolveWorkspaceRoot(sessionId: string, core: CoreInstance): string | undefined {
  return resolveSessionWorkspaceRoot(
    core.rootStore.getter(sessionsAtom)[sessionId],
    core.rootStore.getter(workspacesAtom),
  )
}

export interface WorkspaceInputGuards {
  withWorkspaceRoot<T>(input: T): T
  withWorkspaceReadAccess<T>(input: T): T
  withChangeContext<T>(input: T): T
  withShellCwd(input: ShellCommandInput): ShellCommandInput
}

export function createWorkspaceInputGuards(deps: {
  sessionId: string
  runId: string
  callId: string
  workspaceRoot: string | undefined
  /**
   * Auto 的跨 workspace 只读权限只从宿主会话状态派生。它不会进入工具 schema，且
   * withWorkspaceReadAccess 会覆盖/移除调用方同名字段，避免模型伪造 runtime-only 权限。
   */
  allowExternalReadPaths: boolean
}): WorkspaceInputGuards {
  const { sessionId, runId, callId, workspaceRoot, allowExternalReadPaths } = deps

  // S4-A：把会话 workspaceRoot 注入桥入参 —— session 未绑定则原样（Rust 走 git root 兜底，保持现状）；
  //   调用方（工具）已显式带 workspaceRoot 则尊重调用方、不覆盖；桥不带 input（getWorkspaceDiff）时合成一个。
  function withWorkspaceRoot<T>(input: T): T {
    const record = input !== null && typeof input === 'object' && !Array.isArray(input)
      ? input as Record<string, unknown>
      : {}
    const { allowExternalPaths: _untrusted, ...trustedInput } = record

    if (!workspaceRoot) return trustedInput as T
    if (
      typeof trustedInput.workspaceRoot === 'string'
      && trustedInput.workspaceRoot.trim().length > 0
    ) {
      return trustedInput as T
    }
    return { ...trustedInput, workspaceRoot } as T
  }

  function withWorkspaceReadAccess<T>(input: T): T {
    const rooted = withWorkspaceRoot(input)
    const record = rooted !== null && typeof rooted === 'object' && !Array.isArray(rooted)
      ? rooted as Record<string, unknown>
      : {}
    const { allowExternalPaths: _untrusted, ...trustedInput } = record
    return (
      allowExternalReadPaths
        ? { ...trustedInput, allowExternalPaths: true }
        : trustedInput
    ) as T
  }

  function withChangeContext<T>(input: T): T {
    const record = input !== null && typeof input === 'object' && !Array.isArray(input)
      ? input as Record<string, unknown>
      : {}
    return {
      ...record,
      changeContext: {
        changeId: newId(),
        sessionId,
        runId,
        toolCallId: callId,
      },
    } as T
  }

  function withShellCwd(input: ShellCommandInput): ShellCommandInput {
    if (!workspaceRoot) return input
    const cwd = typeof input.cwd === 'string' && input.cwd.trim().length > 0 ? input.cwd.trim() : undefined
    if (cwd) return { ...input, cwd }
    return { ...input, cwd: workspaceRoot }
  }

  return { withWorkspaceRoot, withWorkspaceReadAccess, withChangeContext, withShellCwd }
}
