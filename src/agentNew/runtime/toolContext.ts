// runtime/toolContext.ts —— 构造工具的副作用白名单 ctx（TOOLS-SPEC §4/§5/§8）。
// ---------------------------------------------------------------------------
// 这是「工具能做的事」的唯一实现方 + 守卫方（取代旧 toolExecution.ts 的内联副作用）：
//   · progress   —— 写会话 store 的瞬态 toolActivityAtom（含 isCurrent/signal 守卫）。
//   · renderCard —— addBrowserCard + stale 守卫，回 {cardId}/{error:'stale'}。
//   · saveArtifact —— addPendingArtifact + stale 守卫，回 {artifactId}/{error:'stale'}。
//   · callTool  —— 经工厂 run 转发，防环 + 限深 + signal 透传；pause 不许经 callTool 冒泡（§8）。
// 工具本身绝不 import atom/store —— 一切副作用都经这里。stale 守卫（ghost + 迟到 run）集中在此，
// 不再由每个工具各写一遍。

import type { ToolContext, ToolResult } from '../tools/types'
import { toolRegistry } from '../tools/registry'
import { rootStore, sessionsAtom } from '../state/rootStore'
import { getSessionStore } from '../state/sessionStore'
import { runAtom } from '../state/sessionAtoms'
import { addBrowserCard, addPendingArtifact, upsertToolActivity } from '../state/transientAtoms'
import { newId } from './newId'
import { runShellCommand } from './shellCommand'
import {
  listWorkspaceFiles,
  readWorkspaceFile,
  searchWorkspaceFiles,
} from './workspaceRead'
import { applyWorkspacePatch } from './workspacePatch'
import { writeWorkspaceFile } from './workspaceWrite'
import { getWorkspaceDiff } from './workspaceGit'

const MAX_TOOL_DEPTH = 4

// stale 守卫：会话仍登记，且该会话当前 run 就是本次 runId（未被新 run 顶掉）。
function isCurrentRun(sessionId: string, runId: string): boolean {
  if (!rootStore.getter(sessionsAtom)[sessionId]) return false
  return getSessionStore(sessionId).store.getter(runAtom)?.runId === runId
}

function shellProgressText(command: string): string {
  const preview = command.replace(/\s+/g, ' ').trim()
  return `执行 shell: ${preview ? preview.slice(0, 120) : '(empty command)'}`
}

function pathProgressText(action: string, path: unknown): string {
  const value = typeof path === 'string' && path.trim() ? path.trim() : '.'
  return `${action}: ${value.slice(0, 160)}`
}

/**
 * 为一次工具调用构造 ctx。callId = 该 tool_call 的 id（进度按它归属）；stack = 当前互调链上的工具名
 * （防环/限深用，顶层为空）。
 */
export function buildToolContext(opts: {
  sessionId: string
  runId: string
  signal: AbortSignal
  callId: string
  toolName: string
  stack?: readonly string[]
}): ToolContext {
  const { sessionId, runId, signal, callId } = opts
  const stack = opts.stack ?? []

  function assertFresh(): void {
    if (signal.aborted || !isCurrentRun(sessionId, runId)) throw new Error('stale')
  }

  const progress: ToolContext['progress'] = (text) => {
    // 迟到/被顶掉的 run 不写进度；esc 已断也不写。
    if (signal.aborted || !isCurrentRun(sessionId, runId)) return
    upsertToolActivity(sessionId, { callId, toolName: opts.toolName, text })
  }

  return {
    sessionId,
    signal,
    progress,

    async runShell(input) {
      assertFresh()
      progress(shellProgressText(input.command))
      const result = await runShellCommand(input)
      assertFresh()
      return result
    },

    async readWorkspaceFile(input) {
      assertFresh()
      progress(pathProgressText('读取文件', input.path))
      const result = await readWorkspaceFile(input)
      assertFresh()
      return result
    },

    async listWorkspaceFiles(input) {
      assertFresh()
      progress(pathProgressText('列出文件', input.path))
      const result = await listWorkspaceFiles(input)
      assertFresh()
      return result
    },

    async searchWorkspaceFiles(input) {
      assertFresh()
      progress(pathProgressText('搜索文件', input.path))
      const result = await searchWorkspaceFiles(input)
      assertFresh()
      return result
    },

    async applyWorkspacePatch(input) {
      assertFresh()
      progress('应用文件 patch')
      const result = await applyWorkspacePatch(input as Parameters<typeof applyWorkspacePatch>[0])
      assertFresh()
      return result
    },

    async writeWorkspaceFile(input) {
      assertFresh()
      const path = typeof input === 'object' && input && 'path' in input ? (input as { path?: unknown }).path : undefined
      progress(pathProgressText('写入文件', path))
      const result = await writeWorkspaceFile(input as Parameters<typeof writeWorkspaceFile>[0])
      assertFresh()
      return result
    },

    async getWorkspaceDiff(input) {
      assertFresh()
      progress('读取 Git diff')
      const result = await getWorkspaceDiff(input as Parameters<typeof getWorkspaceDiff>[0])
      assertFresh()
      return result
    },

    renderCard(card) {
      if (signal.aborted || !isCurrentRun(sessionId, runId)) return { error: 'stale' }
      const cardId = newId()
      addBrowserCard(sessionId, { id: cardId, createdAt: Date.now(), title: card.title, body: card.body })
      return { cardId }
    },

    saveArtifact(file) {
      if (signal.aborted || !isCurrentRun(sessionId, runId)) return { error: 'stale' }
      const artifactId = newId()
      addPendingArtifact(sessionId, {
        id: artifactId,
        filename: file.filename,
        content: file.content,
        mimeType: file.mimeType,
      })
      return { artifactId }
    },

    async callTool(name, args): Promise<ToolResult> {
      // 当前工具（opts.toolName）也在调用链上 —— A 调 A、或 A→B→A，都应在子工具 execute 启动**之前**
      // 就判出环/超深（否则递归的 execute 会先跑一遍、重复副作用，codex P2）。
      const chain = [...stack, opts.toolName]
      if (chain.includes(name)) return { ok: false, error: `tool cycle: ${name}` }
      if (chain.length >= MAX_TOOL_DEPTH) return { ok: false, error: 'tool depth exceeded' }
      const childCtx = buildToolContext({
        sessionId,
        runId,
        signal,
        callId, // 子调用的进度沿用父 callId（同一条 tool_call 的活动）
        toolName: name,
        stack: chain,
      })
      const result = await toolRegistry.run(name, args, childCtx)
      // pause 只能是顶层 model 触发，不许经 callTool 冒泡（避免嵌套暂停语义混乱，§8）。
      if ('pause' in result) return { ok: false, error: 'cannot pause inside callTool' }
      return result
    },
  }
}
