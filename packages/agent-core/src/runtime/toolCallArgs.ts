// ---------------------------------------------------------------------------
// tool_call 参数解析（区分「没传参」与「传了坏 JSON」）
// ---------------------------------------------------------------------------
// 历史：这里曾有一个 safeParseArgs，把「空串」「非法 JSON」「非对象」一律降级成 {}，于是被
// finish_reason='length' 截断的半截 arguments 会被当成「模型就是不传参」而照常执行工具 ——
// 拿默认参数干活比直接报错危险得多，且是最难查的一类故障。现在两者分开：解析失败的 tool_call
// 不执行，改回填一条错误 tool 结果让 model 自己重发。safeParseArgs 已随两条循环迁移完毕而删除。
// ★ 主 agent 循环（modelRun）与子 agent 循环（subagents/runtime）共用这一份判据 ★ ——
//   任何一边另起一套宽松解析，那条循环就会重新开始静默吞坏 JSON。
export type ToolArgsParse =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; args: Record<string, unknown>; error: string; raw: string }

function parseErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

function parsedValueKind(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

// 简介：把 tool_call 的 arguments 字符串解析成判别联合（成功 / 失败带原因+原文）。
// 详情：空串（或纯空白）视为无参工具的合法形态 → { ok:true, args:{} }；
//   非法 JSON / 合法 JSON 但不是对象（数组、标量、null）→ { ok:false }，附中文原因与 trim 后的原文。
//   永不抛。
export function parseToolCallArgs(raw: string | undefined): ToolArgsParse {
  const text = typeof raw === 'string' ? raw.trim() : ''
  // 空 arguments 是无参工具的合法形态，不算失败。
  if (!text) return { ok: true, args: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return {
      ok: false,
      args: {},
      error: `工具参数不是合法 JSON（可能被截断）：${parseErrorMessage(err)}`,
      raw: text,
    }
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return { ok: true, args: parsed as Record<string, unknown> }
  }
  return {
    ok: false,
    args: {},
    error: `工具参数必须是 JSON 对象，实际收到 ${parsedValueKind(parsed)}`,
    raw: text,
  }
}
