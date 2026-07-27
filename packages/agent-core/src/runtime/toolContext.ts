// runtime/toolContext.ts —— 构造工具的副作用白名单 ctx（TOOLS-SPEC §4/§5/§8）。
// ---------------------------------------------------------------------------
// 这是「工具能做的事」的唯一实现方 + 守卫方（取代旧 toolExecution.ts 的内联副作用）：
//   · progress   —— 写会话 store 的瞬态 toolActivityAtom（含 isCurrent/signal 守卫）。
//   · renderCard —— addBrowserCard + stale 守卫，回 {cardId}/{error:'stale'}。
//   · saveArtifact —— addPendingArtifact + stale 守卫，回 {artifactId}/{error:'stale'}。
//   · callTool  —— 经工厂 run 转发，防环 + 限深 + signal 透传；pause 不许经 callTool 冒泡（§8）。
// 工具本身绝不 import atom/store —— 一切副作用都经这里。stale 守卫（ghost + 迟到 run）集中在此，
// 不再由每个工具各写一遍。
//
// 【实例化 · 第 2 期穿线】buildToolContext 末尾加了可选 core（CoreInstance，默认 defaultCore）：
//   ctx 里所有对 store/registry 的读写一律经这个 core —— isCurrentRun / resolveWorkspaceRoot 读
//   core.rootStore，进度/卡片/产物写 core.getSessionStore(id).store（经 writers 的新 core 尾参），
//   callTool 经 core.tools.run 且把 core 递归传给子 ctx。默认 defaultCore＝穿线前的模块全局单例，
//   故不传 core 的调用点（含全部现有测试）行为逐字不变。
//   子 agent 委派路径也沿用当前 core：manifest/schema 由 delegate runtime 的同一 registry 生成，
//   runChildTool 再通过 core.tools 原子校验 schema 快照版本并执行。

import type { ShellCommandInput, ToolContext, ToolResult } from '../tools/types'
import type {
  DelegateAgentCallContext,
  DelegateAgentInput,
  DelegateAgentRuntime,
  SubagentSkillFile,
} from '../subagents/types'
import { getExecutionRuntime } from '../execution/runtime'
import { ROOT_AGENT_PATH } from '../subagents/path'
import { isSubagentWorkspaceReadTool } from '../subagents/toolProfile'
import { commandUsesPermanentDelete, isDelegatableDangerousTool } from './dangerousTools'
import { sessionsAtom, workspacesAtom } from '../state/rootStore'
import { resolveSessionWorkspaceRoot } from '../state/workspaceState'
import { defaultCore, type CoreInstance } from './core/coreInstance'
import { runAtom } from '../state/sessionAtoms'
import { getPlan, setPlan } from '../state/planWriters'
import { PlanRuntime } from '../planning/runtime'
import { EvaluationRuntime } from '../evaluation/runtime'
import {
  addBrowserCard,
  addPendingArtifact,
  isToolAlwaysAllowed,
  upsertToolActivity,
} from '../state/transientAtoms'
import { newId } from './newId'
import { runShellCommand } from './shellCommand'
import {
  listWorkspaceFiles,
  readWorkspaceFile,
  searchWorkspaceFiles,
} from './workspaceRead'
import { rgSearchWorkspace } from './workspaceRg'
import { applyWorkspacePatch } from './workspacePatch'
import { writeWorkspaceFile, type WorkspaceWriteInput, type WorkspaceWriteResult } from './workspaceWrite'
import { deleteWorkspacePath } from './workspaceDelete'
import { revertWorkspaceChange } from './workspaceChange'
import { copyWorkspacePath, moveWorkspacePath } from './workspacePathOperation'
import { getWorkspaceDiff } from './workspaceGit'
import { runWorkspaceTask } from './workspaceTask'

const MAX_TOOL_DEPTH = 4

// stale 守卫：会话仍登记，且该会话当前 run 就是本次 runId（未被新 run 顶掉）。
// 【实例化第 2 期】core 由 buildToolContext 逐处显式传入（无默认值——编译期堵住「漏穿一处退回默认实例」）。
function isCurrentRun(sessionId: string, runId: string, core: CoreInstance): boolean {
  if (!core.rootStore.getter(sessionsAtom)[sessionId]) return false
  return core.getSessionStore(sessionId).store.getter(runAtom)?.runId === runId
}

// S4-A：取该会话绑定的 workspace 根目录（去空白；未设置/空串 → undefined，桥不传 → Rust 走 git root 兜底）。
// 【实例化第 2 期】读会话登记表走 core.rootStore（core 无默认值，由 buildToolContext 传入）。
function resolveWorkspaceRoot(sessionId: string, core: CoreInstance): string | undefined {
  return resolveSessionWorkspaceRoot(
    core.rootStore.getter(sessionsAtom)[sessionId],
    core.rootStore.getter(workspacesAtom),
  )
}

function shellProgressText(command: string): string {
  const preview = command.replace(/\s+/g, ' ').trim()
  return `执行 shell: ${preview ? preview.slice(0, 120) : '(empty command)'}`
}

function pathProgressText(action: string, path: unknown): string {
  const value = typeof path === 'string' && path.trim() ? path.trim() : '.'
  return `${action}: ${value.slice(0, 160)}`
}

function taskProgressText(kind: unknown): string {
  const value = typeof kind === 'string' && kind.trim() ? kind.trim() : 'task'
  return `运行任务: ${value.slice(0, 80)}`
}

function assertSubagentWriteSucceeded(
  result: WorkspaceWriteResult,
  path: string,
  mode: 'create' | 'overwrite' | 'append',
): void {
  if (result.ok) return
  const detail = result.error?.trim() || 'unknown workspace write error'
  throw new Error(`Subagent archive write failed (${mode}) for "${path}": ${detail}`)
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
  toolArgs?: unknown
  stack?: readonly string[]
  agentPath?: string
  getParentTranscript?: () => string
  inheritedSkillFiles?: string[]
  inheritedSkillIds?: string[]
  inheritedSkillContents?: SubagentSkillFile[]
  delegateRuntime?: DelegateAgentRuntime
  // 【实例化第 2 期】core 决定这次工具调用读写哪套 store/registry/abort；默认 defaultCore（＝穿线前
  //   的模块全局单例），故不传 core 的调用点（含全部现有测试）行为逐字不变。callTool 递归时把本次
  //   core 原样传给子 ctx，保证整条同 agent 互调链落在同一实例。
  core?: CoreInstance
}): ToolContext {
  const { sessionId, runId, signal, callId } = opts
  const stack = opts.stack ?? []
  const core = opts.core ?? defaultCore

  // S4-A：本会话 workspace root（ctx 构造期解析一次；一次 run 内稳定）。
  const workspaceRoot = resolveWorkspaceRoot(sessionId, core)
  // Auto 的跨 workspace 只读权限只从宿主会话状态派生。它不会进入工具 schema，且下面的
  // withWorkspaceReadAccess 会覆盖/移除调用方同名字段，避免模型伪造 runtime-only 权限。
  const allowExternalReadPaths =
    core.rootStore.getter(sessionsAtom)[sessionId]?.toolApprovalMode === 'auto'
  const planRuntime = new PlanRuntime({
    get: () => getPlan(sessionId),
    set: (plan) => setPlan(sessionId, plan),
  }, Date.now, newId)
  const evaluationRuntime = new EvaluationRuntime({
    get: () => getPlan(sessionId),
    set: (plan) => setPlan(sessionId, plan),
  })

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

  function assertFresh(): void {
    if (signal.aborted || !isCurrentRun(sessionId, runId, core)) throw new Error('stale')
  }

  // 取消后仍需要写入最终审计事件；但被新 run 顶掉的旧 run 绝不能串写归档。
  function assertArchiveCurrent(): void {
    if (!isCurrentRun(sessionId, runId, core)) throw new Error('stale')
  }

  const progress: ToolContext['progress'] = (text) => {
    // 迟到/被顶掉的 run 不写进度；esc 已断也不写。
    if (signal.aborted || !isCurrentRun(sessionId, runId, core)) return
    upsertToolActivity(sessionId, { callId, toolName: opts.toolName, text }, core)
  }

  async function writeSubagentTextFile(input: {
    path: string
    content: string
    mode?: 'create' | 'overwrite' | 'append'
  }): Promise<unknown> {
    assertArchiveCurrent()
    progress(pathProgressText('写入子 agent 归档', input.path))
    const mode = input.mode ?? 'overwrite'
    const writeInput = withWorkspaceRoot({
      path: input.path,
      content: input.content,
      mode,
      createDirs: true,
      maxBytes: 2 * 1024 * 1024,
      exclusivePathLock: true,
    } satisfies WorkspaceWriteInput)

    let result = await writeWorkspaceFile(writeInput)
    // 归档文件是 snapshot 语义：已存在时覆盖，首次落盘时创建。
    // Rust 的 overwrite 刻意拒绝不存在的目标，因此只对这一个可预期错误回退到 create；
    // 其它错误（包括非 Tauri 运行时）不应被隐藏。
    if (mode === 'overwrite' && !result.ok && result.error?.includes('does not exist')) {
      result = await writeWorkspaceFile({ ...writeInput, mode: 'create' })
    }
    assertArchiveCurrent()
    assertSubagentWriteSucceeded(result, input.path, mode)
    return result
  }

  // 阶段验收的 evaluator 是计划状态机的一部分，归档只是辅助审计记录。
  // Web 环境没有 workspace 写桥，桌面端也可能临时遇到归档目录权限问题；这两类失败都不能
  // 把一个已经产出有效 JSON verdict 的 evaluator 判成失败，否则阶段会永久退回 in_progress。
  // 首次失败后本次 evaluator 不再重复尝试，避免每个事件都撞一次相同的写入错误。
  let evaluatorArchiveUnavailable: string | undefined
  async function writeEvaluatorArchiveBestEffort(input: {
    path: string
    content: string
    mode?: 'create' | 'overwrite' | 'append'
  }): Promise<unknown> {
    if (evaluatorArchiveUnavailable) {
      return { ok: true, skipped: true, warning: evaluatorArchiveUnavailable }
    }
    try {
      return await writeSubagentTextFile(input)
    } catch (error) {
      evaluatorArchiveUnavailable = error instanceof Error ? error.message : String(error)
      progress(`评估器归档已跳过: ${evaluatorArchiveUnavailable}`)
      return { ok: true, skipped: true, warning: evaluatorArchiveUnavailable }
    }
  }

  const ctx: ToolContext = {
    sessionId,
    signal,
    progress,
    createPlan(input) {
      assertFresh()
      return planRuntime.create(input)
    },
    executePlan(planId, revision) {
      assertFresh()
      return planRuntime.execute(planId, revision)
    },
    updatePlan(input) {
      assertFresh()
      return planRuntime.update(input)
    },
    submitStageResult(input) {
      assertFresh()
      return evaluationRuntime.submitStageResult(input)
    },
    evaluateStage(input) {
      // evaluator may finish after the parent tool call has already returned.
      // planId + revision is the freshness guard for this background state
      // transition; tying it to the parent model run would strand `evaluating`.
      return evaluationRuntime.evaluateStage(input)
    },
    evaluatePlan(input) {
      // Same background-completion rule as evaluateStage above.
      return evaluationRuntime.evaluatePlan(input)
    },
    abortStageEvaluation(planId, revision, stageId, reason) {
      // 这是失败补偿，不是旧 run 的普通业务写入。模型请求被中断/替换时，发起验收的 run
      // 很可能已经 stale，但它仍必须尝试把自己留下的 evaluating 回滚掉；真正的并发安全由
      // EvaluationRuntime 的 planId + revision 乐观锁保证，计划已被其他 run 推进时会 fail-closed。
      return evaluationRuntime.abortStageEvaluation(planId, revision, stageId, reason)
    },

    async runShell(input) {
      assertFresh()
      progress(shellProgressText(input.command))
      const result = await runShellCommand(withShellCwd(input))
      assertFresh()
      return commandUsesPermanentDelete(opts.toolName, { command: input.command })
        ? { ...result, reversible: false }
        : result
    },

    async readWorkspaceFile(input) {
      assertFresh()
      progress(pathProgressText('读取文件', input.path))
      const result = await readWorkspaceFile(withWorkspaceReadAccess(input))
      assertFresh()
      return result
    },

    async listWorkspaceFiles(input) {
      assertFresh()
      progress(pathProgressText('列出文件', input.path))
      const result = await listWorkspaceFiles(withWorkspaceReadAccess(input))
      assertFresh()
      return result
    },

    async searchWorkspaceFiles(input) {
      assertFresh()
      progress(pathProgressText('搜索文件', input.path))
      const result = await searchWorkspaceFiles(withWorkspaceReadAccess(input))
      assertFresh()
      return result
    },

    async rgSearchWorkspace(input) {
      assertFresh()
      progress(pathProgressText('rg 搜索', input.path))
      const result = await rgSearchWorkspace(withWorkspaceReadAccess(input))
      assertFresh()
      return result
    },

    async applyWorkspacePatch(input) {
      assertFresh()
      progress('应用文件 patch')
      const result = await applyWorkspacePatch(
        withChangeContext(
          withWorkspaceRoot(input as Parameters<typeof applyWorkspacePatch>[0]),
        ),
      )
      assertFresh()
      return result
    },

    async writeWorkspaceFile(input) {
      assertFresh()
      const path = typeof input === 'object' && input && 'path' in input ? (input as { path?: unknown }).path : undefined
      progress(pathProgressText('写入文件', path))
      const result = await writeWorkspaceFile(
        withChangeContext(
          withWorkspaceRoot(input as Parameters<typeof writeWorkspaceFile>[0]),
        ),
      )
      assertFresh()
      return result
    },

    async deleteWorkspacePath(input) {
      assertFresh()
      const path = typeof input === 'object' && input && 'path' in input
        ? (input as { path?: unknown }).path
        : undefined
      progress(pathProgressText('删除路径', path))
      const result = await deleteWorkspacePath(
        withChangeContext(
          withWorkspaceRoot(input as Parameters<typeof deleteWorkspacePath>[0]),
        ),
      )
      assertFresh()
      return result
    },

    async copyWorkspacePath(input) {
      assertFresh()
      progress('复制路径')
      const result = await copyWorkspacePath(
        withChangeContext(withWorkspaceRoot(input as Parameters<typeof copyWorkspacePath>[0])),
      )
      assertFresh()
      return result
    },

    async moveWorkspacePath(input) {
      assertFresh()
      progress('移动路径')
      const result = await moveWorkspacePath(
        withChangeContext(withWorkspaceRoot(input as Parameters<typeof moveWorkspacePath>[0])),
      )
      assertFresh()
      return result
    },

    async revertWorkspaceChange(input) {
      assertFresh()
      progress('回退文件更改')
      const result = await revertWorkspaceChange(
        withWorkspaceRoot(input as Parameters<typeof revertWorkspaceChange>[0]),
      )
      assertFresh()
      return result
    },

    async getWorkspaceDiff(input) {
      assertFresh()
      progress('读取 Git diff')
      const result = await getWorkspaceDiff(
        withWorkspaceRoot(input as Parameters<typeof getWorkspaceDiff>[0]),
      )
      assertFresh()
      return result
    },

    async runWorkspaceTask(input) {
      assertFresh()
      progress(taskProgressText(input.kind))
      const result = await runWorkspaceTask(withWorkspaceRoot(input))
      assertFresh()
      return result
    },

    renderCard(card) {
      if (signal.aborted || !isCurrentRun(sessionId, runId, core)) return { error: 'stale' }
      const cardId = newId()
      addBrowserCard(sessionId, { id: cardId, createdAt: Date.now(), title: card.title, body: card.body }, core)
      return { cardId }
    },

    saveArtifact(file) {
      if (signal.aborted || !isCurrentRun(sessionId, runId, core)) return { error: 'stale' }
      const artifactId = newId()
      addPendingArtifact(sessionId, {
        id: artifactId,
        filename: file.filename,
        content: file.content,
        mimeType: file.mimeType,
      }, core)
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
        toolArgs: args,
        stack: chain,
        agentPath: opts.agentPath,
        getParentTranscript: opts.getParentTranscript,
        inheritedSkillFiles: opts.inheritedSkillFiles,
        inheritedSkillIds: opts.inheritedSkillIds,
        inheritedSkillContents: opts.inheritedSkillContents,
        delegateRuntime: opts.delegateRuntime,
        core, // 同 agent 互调链共用同一实例（子 ctx 也走本次 core）。
      })
      const result = await core.tools.run(name, args, childCtx)
      // pause 只能是顶层 model 触发，不许经 callTool 冒泡（避免嵌套暂停语义混乱，§8）。
      if ('pause' in result) return { ok: false, error: 'cannot pause inside callTool' }
      return result
    },
  }

  if (opts.delegateRuntime) {
    const buildDelegateCallContext = (input: DelegateAgentInput): DelegateAgentCallContext => {
      const requestedConfirmedTools = opts.toolName === 'delegate_agent'
        && opts.toolArgs && typeof opts.toolArgs === 'object' && !Array.isArray(opts.toolArgs)
        && Array.isArray((opts.toolArgs as Record<string, unknown>).confirmedTools)
        ? Array.from(new Set(
            ((opts.toolArgs as Record<string, unknown>).confirmedTools as unknown[])
              .filter((name): name is string =>
                typeof name === 'string' && isDelegatableDangerousTool(name))
              .filter((name) => isToolAlwaysAllowed(sessionId, name, core)),
          ))
        : []
      const dangerousToolCapability = requestedConfirmedTools.length > 0
        ? {
            sessionId,
            runId,
            delegationCallId: callId,
            parentPath: opts.agentPath ?? ROOT_AGENT_PATH,
            toolNames: requestedConfirmedTools,
          }
        : undefined
      const callContext: DelegateAgentCallContext = {
        parentPath: opts.agentPath ?? ROOT_AGENT_PATH,
        delegationCallId: callId,
        parentTranscript: opts.getParentTranscript?.(),
        inheritedSkillFiles: opts.inheritedSkillFiles,
        inheritedSkillIds: opts.inheritedSkillIds,
        inheritedSkillContents: opts.inheritedSkillContents,
        dangerousToolCapability,
        progress,
        writeTextFile: opts.toolName === 'submit_stage_result'
          ? writeEvaluatorArchiveBestEffort
          : writeSubagentTextFile,
        async runChildTool(name, args, expectedRegistrationVersion) {
          assertFresh()
          const confirmedDangerousTool = dangerousToolCapability?.toolNames.includes(name) === true
          if (!isSubagentWorkspaceReadTool(name) && !confirmedDangerousTool) {
            return { ok: false, error: `tool not allowed for child agent: ${name}` }
          }
          const result = await core.tools.run(
            name,
            args,
            ctx,
            expectedRegistrationVersion,
          )
          assertFresh()
          if ('pause' in result) return { ok: false, error: 'child tools cannot pause' }
          return result
        },
      }
      return callContext
    }
    ctx.delegateAgents = (input) =>
      opts.delegateRuntime!.delegateAgents(input, buildDelegateCallContext(input))
    ctx.spawnAgents = (input, options) => {
      const callContext = buildDelegateCallContext(input)
      opts.delegateRuntime!.retain?.()
      return getExecutionRuntime(core).spawn({
        sessionId,
        runId,
        label: input.children.map((child) => child.objective).join('；'),
        task: async (executionSignal) => {
          const cancelDelegateRuntime = () => opts.delegateRuntime!.cancel?.()
          executionSignal.addEventListener('abort', cancelDelegateRuntime, { once: true })
          if (executionSignal.aborted) cancelDelegateRuntime()
          try {
            const result = await opts.delegateRuntime!.delegateAgents(input, callContext)
            return options?.onComplete ? await options.onComplete(result) : result
          } catch (error) {
            await options?.onError?.(error)
            throw error
          } finally {
            executionSignal.removeEventListener('abort', cancelDelegateRuntime)
            opts.delegateRuntime!.release?.()
          }
        },
      })
    }
    ctx.observeExecution = (executionId) =>
      getExecutionRuntime(core).observe(sessionId, executionId)
    ctx.joinExecution = (executionId) =>
      getExecutionRuntime(core).join(sessionId, executionId)
    ctx.cancelExecution = (executionId) =>
      getExecutionRuntime(core).cancel(sessionId, executionId)
  }

  return ctx
}
