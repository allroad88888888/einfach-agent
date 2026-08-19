// 任务 kind：合法值、解析、kind → package.json script 名的映射
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_task.rs（已随 T1 删除）的 `TaskKind`。
//
// 五个 kind 里 `cargo_check` 不走 package.json（它跑的是 `cargo check`），其余四个
// kind 名恰好与它们要跑的 npm script 名相同（`test` → `test`，以此类推）——这不是巧合，
// 是 Rust 侧就这么设计的，本移植原样保留这个巧合，不要因为「看起来多余」就精简掉映射表。

export type TaskKind = 'test' | 'build' | 'lint' | 'typecheck' | 'cargo_check'

const VALID_KINDS: readonly TaskKind[] = ['test', 'build', 'lint', 'typecheck', 'cargo_check']

/**
 * 解析一个字符串成 `TaskKind`。失败时的消息逐字对齐 Rust（英文，两个宿主对同一次非法
 * kind 必须说同一句话）。
 */
export function parseTaskKind(value: string): TaskKind {
  const found = VALID_KINDS.find((kind) => kind === value)
  if (found) return found
  throw new Error(
    `unsupported task kind \`${value}\`; expected \`test\`, \`build\`, \`lint\`, \`typecheck\`, or \`cargo_check\``,
  )
}

/** kind 对应的 package.json script 名；`cargo_check` 不走 script，返回 `undefined`。 */
export function packageScriptForKind(kind: TaskKind): string | undefined {
  return kind === 'cargo_check' ? undefined : kind
}
