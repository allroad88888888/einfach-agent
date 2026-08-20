// toolContext workspaceRoot / verifyProfile 测试套件的公共夹具与 helper —— 不含任何 it/describe，
// 也不含 vi.mock（vi.mock 按文件 hoist 生效，塞进共享模块会破坏该语义，同款说明见
// modelRun.testHarness.ts 头部注释）。拆分自 toolContext.workspaceRoot.test.ts（A2b），供
// toolContext.workspaceRoot.test.ts 与 toolContext.verifyProfile.test.ts 两个用例文件复用。

import { expect } from 'vitest'
import { rootStore, sessionsAtom } from '../state/rootStore'
import { setRun } from '../state/sessionWriters'
import type { CoreInstance } from './core/coreInstance'
import type { DelegateAgentBatchResult, DelegateAgentInput, DelegateAgentRuntime } from '../subagents/types'
import type { ToolContext } from '../tools/types'

// 登记一个 running 会话（可选 workspaceRoot）,让 ctx.assertFresh 通过。默认写全局 defaultCore
// 的 rootStore；传 core 时改写该隔离实例自己的 rootStore（供「拒绝过期注册版本」一类需要
// createCoreInstance() 的用例复用，不必手写一遍 setter + setRun）。
export function seedSession(
  id: string,
  workspaceRoot?: string,
  toolApprovalMode?: 'confirm' | 'auto',
  core?: CoreInstance,
): void {
  const store = core?.rootStore ?? rootStore
  store.setter(sessionsAtom, (prev) => ({
    ...prev,
    [id]: {
      id,
      title: 't',
      settings: { vendor: 'deepseek', model: 'x' },
      createdAt: 0,
      updatedAt: 0,
      workspaceRoot,
      toolApprovalMode,
    },
  }))
  setRun(id, { runId: 'r', status: 'running' }, core)
}

// 委派只有 spawn 一条路（同步分支已删）：起执行节点再 join。内部抛错被节点收成 failed 而不再
// 向调用方抛，所以必须看一眼状态，否则下面那些「捕获值」断言会对着 undefined 假绿。
export async function runDelegation(ctx: ToolContext, input: DelegateAgentInput): Promise<void> {
  const handle = ctx.spawnAgents!(input)
  await expect(ctx.joinExecution!(handle.executionId)).resolves.toMatchObject({ status: 'succeeded' })
}

// mock DelegateAgentRuntime 各用例共用的「done」批次结果外壳——内容本身不是断言目标，
// 各测试只关心 delegateAgents 回调里对 callContext 的捕获，所以字段值都是占位。
export function fakeDelegationBatchResult(conversationId: string): DelegateAgentBatchResult {
  return {
    treeId: 'r',
    conversationId,
    runId: 'r',
    parentPath: 'root',
    strategy: 'parallel_wait_all',
    status: 'done',
    summary: { total: 0, done: 0, failed: 0, cancelled: 0 },
    cacheBasePath: '.webAgent-archive/test',
    archiveBasePath: '.webAgent-archive/test',
    eventLog: '.webAgent-archive/test/events.jsonl',
    skillFiles: [],
    skillIds: [],
    children: [],
  }
}

export type DelegateAgentRuntimeCallContext = Parameters<DelegateAgentRuntime['delegateAgents']>[1]

// 各用例只关心 delegateAgents 回调里对 callContext 的捕获，批次结果外壳统一走
// fakeDelegationBatchResult。两个用例文件（workspaceRoot 透传 / verifyProfile 闸门）共用。
export function delegateRuntimeCapturing(
  run: (callContext: DelegateAgentRuntimeCallContext) => Promise<void>,
  conversationId: string,
): DelegateAgentRuntime {
  return {
    async delegateAgents(_input, callContext) {
      await run(callContext)
      return fakeDelegationBatchResult(conversationId)
    },
  }
}
