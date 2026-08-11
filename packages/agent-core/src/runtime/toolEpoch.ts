// runtime/toolEpoch.ts —— 一个 run 的【工具集 epoch】：run 开始时固定下来的工具目录。
//
// 病灶：toolRegistry 是进程级共享且随时可变的。MCP 的 tools/list_changed 通知与断线
// 都会【立刻】注册新工具或注销旧工具。于是模型在 T0 拿到工具清单、据此决策，T1 要调用
// 时那个工具可能已经不在了——清单当场变形，模型看到的世界和运行时的世界对不上。
//
// 对策：run 一开始就 registry.snapshot() 冻结一份目录，本 run 全程只读这份 epoch。
// 语义分成两层，缺一不可：
//
//   ① 成员固定（本 issue 的承诺）。epoch 的名字集合在 run 开始时定死：
//      · run 中途注销的工具【不会】从清单里消失——它仍在 manifest、仍带着当时的 schema，
//        避免 provider 前缀缓存整段失效，也避免模型的既有决策凭空落空；
//      · run 中途新注册的工具【不会】混进清单——注入的 manifest 文本是 run 开始时组装的，
//        若发现面偷偷多出工具，模型会看到两套互相矛盾的事实。
//
//   ② 成员内的注册版本跟随 registry（不是冻结）。同名工具被覆盖（MCP 重连、tools_changed
//      重注册）时，loadSchema / registrationVersion 返回【当前那一版】。这不是妥协，是安全要求：
//      真正执行的是 registry 里活着的那个实例，若把 schema 冻在旧版，就等于拿旧参数去喂新实例，
//      而 registry.run 的 expectedRegistrationVersion 会 fail-closed——那个工具在本 run 剩余
//      时间里将永久不可用。跟随版本后，既有的「registration_changed → 重新 request_tool_schema」
//      自愈路径继续成立。
//
// 未落在本层的两件事（各自有独立 issue，接口已在此预留）：
//   · E2「run 期间只增不减」：新增靠放宽 ① 的成员判定；被注销的工具在调用时给结构化错误，
//     判据就是 status(name) === 'retired'。
//   · E3「待确认工具的版本校验并入 epoch」：run 暂停等待确认时循环已退出，命令层要按
//     (sessionId, runId) 找回同一个 epoch —— 见 toolEpochStore.ts。

import type { ToolCatalog } from '../tools/toolCatalog'
import type { ToolRegistry } from '../tools/toolRegistry'

/**
 * 某个工具名相对本 run epoch 的状态：
 *   · live    —— 在 epoch 成员内，registry 里也仍有同名注册（可正常执行）；
 *   · retired —— 在 epoch 成员内，但 registry 已注销（清单里还在，执行会失败）；
 *   · absent  —— 不在本 run 的 epoch 内（含 run 中途才注册的工具）。
 */
export type ToolEpochStatus = 'live' | 'retired' | 'absent'

/** 一个 run 固定下来的工具目录。读面与 ToolCatalog 完全一致，可直接替换 registry。 */
export interface ToolEpoch extends ToolCatalog {
  /** 进程内唯一、可进 trace 的 epoch 标识。 */
  readonly epochId: string
  readonly sessionId: string
  readonly runId: string
  readonly capturedAt: number
  /** 本 run 固定的工具名集合（按捕获顺序）。 */
  readonly toolNames: readonly string[]
  /** 成员/存活判定的唯一入口；E2 的结构化错误与 E3 的确认校验都从这里取判据。 */
  status(name: string): ToolEpochStatus
}

export interface ToolEpochInput {
  sessionId: string
  runId: string
  now?: () => number
}

let epochSequence = 0

/** 冻结 registry 此刻的工具目录，产出一个 run 专属 epoch。 */
export function createToolEpoch(registry: ToolRegistry, input: ToolEpochInput): ToolEpoch {
  const frozen = registry.snapshot()
  const toolNames = Object.freeze(frozen.list().map((tool) => tool.name))
  epochSequence += 1
  const epochId = `epoch-${epochSequence}`
  const capturedAt = (input.now ?? Date.now)()

  // 成员判定只看快照：run 中途新注册的名字一律 absent（E2 会放宽这一条）。
  const isMember = (name: string): boolean => frozen.has(name)

  return {
    epochId,
    sessionId: input.sessionId,
    runId: input.runId,
    capturedAt,
    toolNames,
    list() {
      return frozen.list()
    },
    has(name) {
      return isMember(name)
    },
    replayUnsafeToolNames() {
      return frozen.replayUnsafeToolNames()
    },
    loadSchema(name) {
      if (!isMember(name)) return undefined
      // 见文件头 ②：成员的 schema 跟随活注册，注销后回落到 run 开始时的那一份。
      return registry.loadSchema(name) ?? frozen.loadSchema(name)
    },
    registrationVersion(name) {
      if (!isMember(name)) return undefined
      return registry.registrationVersion(name) ?? frozen.registrationVersion(name)
    },
    status(name) {
      if (!isMember(name)) return 'absent'
      return registry.has(name) ? 'live' : 'retired'
    },
  }
}
