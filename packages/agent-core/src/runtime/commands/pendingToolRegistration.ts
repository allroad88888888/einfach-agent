// runtime/commands/pendingToolRegistration.ts —— 待确认工具在【恢复执行】那一刻的注册判据。
//
// 病灶：危险工具确认会让 runToolLoop 返回，等用户点按钮的这几分钟里 registry 随时可能变——
// MCP 重连（同名换一个实例）和掉线（直接注销）都不需要征得任何人同意。用户点「允许」时，
// 卡片上那份工具描述可能已经不对应 registry 里活着的东西了。
//
// 判据要来自【本 run 的工具集 epoch】而不是活 registry：epoch 按 (sessionId, runId) 存放，
// 暂停期间不会被重新冻结（见 runtime/toolEpochStore.ts），因此它能答出活 registry 答不出的
// 那件事——这个名字在本 run 开始时【在过】清单里，只是现在没了（status === 'retired'）。
// 于是「换了一版」与「服务没了」不再挤在同一个 undefined 里，也不需要看工具名长什么样。
//
// 三种结论，对应三种恢复动作：
//   · current      —— 用户批准的就是活着的那一版：照常恢复执行。
//   · reregistered —— 同名工具被换了一版（MCP 重连 / tools_changed）。仍走原恢复路径，由
//        registry.run 的 expectedRegistrationVersion fail-closed 挡下，回一句
//        `tool registration version mismatch`；模型重读 schema 就能自愈，属于可恢复错误。
//   · disconnected —— 该工具所属的服务在本 run 内已断开。本轮无救：恢复执行必然失败，且
//        registry 只会回一句给运维看的 `unknown tool: X`，调用方应改回 E2 的
//        tool_provider_disconnected 结构化回执（见 runtime/toolLoading.ts）。
//
// 拿不到 epoch（进程重启后恢复的 run、或该会话的 epoch 已被新 run 顶掉）时回退到活 registry
// 的版本比对：与本判据统一之前的逻辑逐字一致，且只会更严不会更松——registry 答不出版本时
// 结论是 reregistered（fail-closed），绝不因为「没有判据」就当作 current 放行。此时也不产出
// disconnected：区分「掉线」与「本来就没有这个名字」需要 run 开始时的那份清单，而清单恰恰
// 是随 epoch 一起没的。

import type { PendingToolConfirmation } from '../../state/core.type'
import type { CoreInstance } from '../core/coreInstance'
import type { ToolEpochStatus } from '../toolEpoch'
import type { ToolCatalog } from '../../tools/toolCatalog'

export type PendingToolRegistrationState = 'current' | 'reregistered' | 'disconnected'

export interface PendingToolRegistrationCheck {
  state: PendingToolRegistrationState
  /** 判据来源：epoch = 本 run 冻结的工具集；registry = 拿不到 epoch 时的兜底。 */
  source: 'epoch' | 'registry'
  epochId?: string
  epochStatus?: ToolEpochStatus
  /** 判据来源认为当前有效的注册版本；用于 trace 与失败回执的取证。 */
  currentRegistrationVersion: number | undefined
}

/** 判断一个等待确认的工具调用，在用户点下「允许」的此刻还能不能按原样执行。 */
export function checkPendingToolRegistration(
  core: CoreInstance,
  sessionId: string,
  runId: string,
  pending: PendingToolConfirmation,
): PendingToolRegistrationCheck {
  const epoch = core.toolEpochs.get(sessionId, runId)
  const catalog: ToolCatalog = epoch ?? core.tools
  const currentRegistrationVersion = catalog.registrationVersion(pending.toolName)
  if (!epoch) {
    return { state: versionState(pending, currentRegistrationVersion), source: 'registry', currentRegistrationVersion }
  }
  const epochStatus = epoch.status(pending.toolName)
  return {
    state: epochStatus === 'retired' ? 'disconnected' : versionState(pending, currentRegistrationVersion),
    source: 'epoch',
    epochId: epoch.epochId,
    epochStatus,
    currentRegistrationVersion,
  }
}

// pending.registrationVersion 缺省 = 这次确认没记下版本（旧 checkpoint / 手工构造的 run 状态），
// 此时没有可比对的东西，维持原判定：不因缺少版本而额外拒绝。
function versionState(
  pending: PendingToolConfirmation,
  currentRegistrationVersion: number | undefined,
): PendingToolRegistrationState {
  if (pending.registrationVersion === undefined) return 'current'
  return currentRegistrationVersion === pending.registrationVersion ? 'current' : 'reregistered'
}
