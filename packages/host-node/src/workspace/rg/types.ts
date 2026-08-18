// rg_search_workspace 的输出形状
// ---------------------------------------------------------------------------
// 字段名一律 camelCase，对齐 Rust 侧 `#[serde(rename_all = "camelCase")]`（workspace_rg.rs 的
// `RgSearchResult` / `RgSearchMatch`）。这也是 Tauri 命令实际吐给前端的 JSON 形状；core 的
// `runtime/workspaceRg.ts` 的 `normalizeResult` 优先认 camelCase 键（`raw.lineNumber ?? raw.line_number`），
// 所以两个宿主在这一步给出同一种形状最省事。

/** 一条命中，含它自己的上下文行。 */
export interface RgSearchMatch {
  /** 根相对（或越权时绝对）的展示路径，正斜杠。 */
  path: string
  lineNumber: number
  /** 1-based 列号。 */
  column: number
  line: string
  /** 命中行之前的上下文，最多 contextLines 行。 */
  before: string[]
  /** 命中行之后的上下文，最多 contextLines 行。 */
  after: string[]
}

export interface RgSearchResult {
  ok: boolean
  matches: RgSearchMatch[]
  truncated: boolean
  exitCode: number
  stderr: string
}

/** 等价 Rust 的 `failed_result`：请求侧或 rg 自身失败时的统一形状。 */
export function failedRgResult(stderr: string): RgSearchResult {
  return { ok: false, matches: [], truncated: false, exitCode: 1, stderr }
}
