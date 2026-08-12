/**
 * 工具的到点执行时机。
 *
 * 九个核心时机由 loop 分派；`<domain>:<event>` 形式留给宿主或插件经公开分派 API 触发的
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
  | 'postCompact'
  | 'subagentStart'
  | 'subagentEnd'
  | `${string}:${string}`
