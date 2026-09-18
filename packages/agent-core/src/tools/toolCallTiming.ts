/**
 * 工具的到点执行时机。
 *
 * 十个核心时机由 loop 分派：session/run/turn 五个在 `runtime/toolLoopBootstrap.ts` 与
 * `runtime/runToolLoop.ts`，`subagentStart`/`subagentEnd` 在 `subagents/childAgentLoop.ts`，
 * 主会话在超预算时分派 preCompact → compact → postCompact；compact 调用注册的压缩工具，
 * 子 Agent 也用 compact 工具，但绑定自己的上下文。未超预算的轮次不触发压缩。
 * `<domain>:<event>` 形式留给宿主或插件经公开分派 API 触发的
 * 扩展时机（例如未来的 `mcp:connected`）。callTiming 非空的工具不进模型可见清单，
 * 剔除判定一律按「非空」而非穷举枚举——增补时机不触碰发现面。
 *
 * 危险约束不在注册期表达：风险由运行时按调用上下文评估（dangerousTools 与确认门插件），
 * 到点分派不经过确认门，因此分派器在执行前必须咨询既有风险评估，非 safe 的到点调用
 * 拒绝执行并记诊断。
 */
export type ToolCallTiming =
  | 'sessionStart'
  | 'runStart'
  | 'runEnd'
  | 'turnStart'
  | 'turnEnd'
  | 'preCompact'
  | 'compact'
  | 'postCompact'
  | 'subagentStart'
  | 'subagentEnd'
  | `${string}:${string}`
