// 标量入参的收窄与钳制：query / contextLines / maxMatches / regex / caseSensitive
// ---------------------------------------------------------------------------
// 对齐 Rust 侧的 `normalize_context_lines` / `normalize_max_matches` 与
// `rg_search_workspace_blocking` 顶部对 query 的处理。
//
// Rust 的 `context_lines` / `max_matches` 是 `Option<usize>`：deserialize 阶段就会挡掉负数，
// 这一层不需要处理「传了负数」。Node 侧 handler 拿到的是未经校验的 `unknown`，没有对应的
// deserialize 关卡，所以这里补一条**没有 Rust 对应物**的兜底：非有限、非整数或负数一律当作
// 「没传」处理，退回默认值——不是拒绝整个请求（本域的失败面只留给「query 为空」「路径越界」
// 「globs 非法」「rg 缺失」这几条与 Rust 对齐的路径，标量参数收窄失败没有必要让整次搜索落空）。

/** 非负整数才当作「调用方传了值」，否则视为未传（回退默认值）。 */
function nonNegativeIntegerOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0
    ? value
    : undefined
}

/** trim 后的 query；空字符串本身就是「非法」，由调用方（handler）据此短路返回失败结果。 */
export function normalizeQuery(rawQuery: unknown): string {
  return typeof rawQuery === 'string' ? rawQuery.trim() : ''
}

/** 对齐 `normalize_context_lines`：`unwrap_or(DEFAULT).min(MAX)`。 */
export function normalizeContextLines(rawContextLines: unknown, defaultValue: number, max: number): number {
  const value = nonNegativeIntegerOrUndefined(rawContextLines) ?? defaultValue
  return Math.min(value, max)
}

/**
 * 对齐 `normalize_max_matches`：`Some(value) if value > 0 => value.min(MAX)`，否则（含 0、
 * 未传、非法值）退回默认值——0 不是「不限」，是「没有有效值」。
 */
export function normalizeMaxMatches(rawMaxMatches: unknown, defaultValue: number, max: number): number {
  const value = nonNegativeIntegerOrUndefined(rawMaxMatches)
  if (value === undefined || value <= 0) return defaultValue
  return Math.min(value, max)
}

/** `regex` 默认 false（Rust：`regex.unwrap_or(false)`）。 */
export function normalizeRegex(rawRegex: unknown): boolean {
  return typeof rawRegex === 'boolean' ? rawRegex : false
}

/** `caseSensitive` 默认 true（Rust：`case_sensitive.unwrap_or(true)`）。 */
export function normalizeCaseSensitive(rawCaseSensitive: unknown): boolean {
  return typeof rawCaseSensitive === 'boolean' ? rawCaseSensitive : true
}
