// 工具可重复性分级 —— 只回答一个问题：**中断时结果未知的调用，能不能直接重试。**
// ---------------------------------------------------------------------------
// 与 `dangerousTools.ts` 的 `classifyToolRisk` 是两个正交维度，别混用：
//   · 风险（safe / dangerous / critical）决定**执行前要不要问用户**；
//   · 本文件的分级决定**崩溃恢复时能不能重发**。
// 一个工具可以是 safe 却不可重复（`save_file` 会重复落一份产物），也可以是 dangerous
// 却只读（不存在，但类型上不冲突）。
//
// ## 为什么只有两档
//
// Rust 侧（einfach-agent-rust `docs/TOOLS.md` §reversibility）分三档，中间那档 `Reversible`
// 的判据是「有明确的补偿动作，且补偿本身可靠」。web-agent **没有补偿动作注册表**，现造一个
// 就是编造：一个不可靠的补偿比多问用户一次糟得多。所以本文件只有 `pure` 和 `irreversible`，
// 有补偿语义的工具一律落到 `irreversible`（从严方向）。补偿注册表落地后再加中间档。
//
// ## 为什么是按名字查表，而不是注册期元数据
//
// `TOOLS-SPEC.md` §2 明确「危险约束不在注册期表达：风险由运行时按调用上下文评估」。
// 可重复性虽然比风险静态，但把它做成 `Tool` 的字段会让外部声明工具（MCP 清单）可以自称
// `pure` —— 那正是本判据最不能交给外部的部分。Rust 侧的 `reversibility_of(name)` 同样是
// 硬编码 match + 仅 `mcp:` 前缀查表，两边形状一致。
//
// ## 兜底方向
//
// 判错成 `pure` 的代价是重复产生副作用；判错成 `irreversible` 的代价只是多问用户一次。
// 所以默认值是 `irreversible`，**只有显式列出的只读工具才是 `pure`**。

import { isMcpTool } from './dangerousTools'

export type ToolReversibility = 'pure' | 'irreversible'

/**
 * 重复执行任意次都不改变外部世界的工具。逐个核对过各自实际用到的 `ToolContext` 能力，
 * 不是照 TOOLS-SPEC 的清单抄的（那份清单自己声明容易过时）。
 *
 * 刻意**不在**表里的几个近似项：
 * - `find_test_lint_commands`：会调 `ctx.runLowCostExtraction`，重发要重复付费。
 * - `git_diff_review`：只读，但经 shell 执行；shell 一律不进本表。
 * - `save_file`：`ok` 只回 artifactId 与字节数，重发会重复落一份产物。
 * - `join_agent` / `cancel_agent`：改变后台执行节点的状态。
 */
const PURE_TOOLS: ReadonlySet<string> = new Set([
  // filesystem 读取面
  'read_file',
  'list_files',
  'search_files',
  'rg_search',
  // 计划只读
  'get_plan',
  // skills 只读（清单 / 检索 / 正文）
  'skill_manifest',
  'skill_search',
  'skill_read',
  // 读一个后台执行节点，不等待、不改状态
  'observe_agent',
])

/**
 * 判定一个工具能否在「结果未知」的中断后安全重发。
 * 未知名字、外部声明工具（MCP）一律 `irreversible` —— 外部服务的副作用不可知。
 */
export function classifyToolReversibility(name: string): ToolReversibility {
  if (isMcpTool(name)) return 'irreversible'
  return PURE_TOOLS.has(name) ? 'pure' : 'irreversible'
}

/** `classifyToolReversibility(name) === 'pure'` 的简写，供恢复路径逐调用判定。 */
export function isPureTool(name: string): boolean {
  return classifyToolReversibility(name) === 'pure'
}
