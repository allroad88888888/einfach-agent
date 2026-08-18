// `read_workspace_file` 的命令入口：在字节分页与行定位之间选路
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_read.rs 的 `read_workspace_file_blocking_at_lines`。
// **这是 `read_workspace_file` 唯一该被注册的 handler**——两种寻址模式是同一条命令，
// registrar 挂本文件的 `createReadWorkspaceFileHandler`，不要直接挂 bytesRead 的那个工厂
// （那样行参数会被静默忽略：模型传 startLine 却拿到从头 20 KB，且全程不报错）。
//
// 【分派的确切判据，逐条对齐 Rust】
//   1. `start_line` 与 `line_count` **两个都没给** → 走字节模式，原路调 `readWorkspaceFileBytes`。
//      即「行模式由这两个键中任意一个触发」，不是只看 startLine：只给 lineCount 也是行模式，
//      起始行默认第 1 行。
//   2. 进了行模式后，`offset` **大于 0** 才算冲突并整体拒绝；`offset: 0` 不算「传了」，与不传
//      等价（Rust：`offset.is_some_and(|value| value > 0)`）。理由是同时给两个游标会让「续读」
//      产生两个互相矛盾的位置。
//   3. 冲突判定只看 offset，**不看是哪个行参数触发的行模式**：只给 `line_count` 加非零 offset
//      同样被拒，而错误文案说的是 "pass either offset or startLine"。这是 Rust 侧的措辞与
//      判据不完全贴合，照搬不改（改文案就是制造两个宿主的分叉）。
//   4. `start_line: 0` / `line_count: 0` 都**进得来**，由行模式实现给出各自的 1-based /
//      greater-than-0 错误——它们是「传了一个非法值」，不是「没传」。
//
// 【入参收窄】顶层键是 snake_case（`read_workspace_file` 带 `rename_all = "snake_case"`，
// core 的 `toTauriReadInput` 已经转好）。判「传没传」只看值、不用 `'key' in args`：走 HTTP 时
// `JSON.stringify` 会丢掉值为 undefined 的键，同一份入参在两种传输下键集合不同。
// 非负整数以外的一切（负数、小数、非有限、非数字）一律当作没传，理由与 W1 的
// `bytesRead.ts` 逐字相同（Rust 侧这些值在 Tauri 的 deserialize 阶段就被挡掉，Node 没有那道
// 关卡）。那份实现今天是 bytesRead.ts 的私有函数，本文件保留一份等价的；read 域四张卡
// （W1–W4）落齐后由接线方决定要不要收成一处，本卡不动别人的文件。

import { readWorkspaceFileBytes } from './bytesRead'
import { readWorkspaceFileLines } from './linesRead'
import type { ReadWorkspaceFileResult } from './types'
import type { NodeHostInvokeOptions } from '../../hostOptions'
import type { NodeHostCommandHandler } from '../../routeTable'

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' ? value : undefined
}

function nonNegativeIntegerArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

/** `read_workspace_file`：按入参在字节分页与行定位之间选路。 */
export async function readWorkspaceFile(
  args: Record<string, unknown>,
): Promise<ReadWorkspaceFileResult> {
  const startLine = nonNegativeIntegerArg(args, 'start_line')
  const lineCount = nonNegativeIntegerArg(args, 'line_count')
  if (startLine === undefined && lineCount === undefined) {
    return readWorkspaceFileBytes(args)
  }

  const offset = nonNegativeIntegerArg(args, 'offset')
  if (offset !== undefined && offset > 0) {
    throw new Error(
      'pass either offset or startLine, not both; use nextLine to continue a line read',
    )
  }

  return readWorkspaceFileLines({
    path: stringArg(args, 'path') ?? '',
    maxBytes: nonNegativeIntegerArg(args, 'max_bytes'),
    startLine: startLine ?? 1,
    lineCount,
    workspaceRoot: stringArg(args, 'workspace_root'),
    allowExternalPaths: args.allow_external_paths === true,
  })
}

/** `read_workspace_file` 的 handler 工厂。read 域的 registrar 注册的就是这一个。 */
export function createReadWorkspaceFileHandler(
  _options: NodeHostInvokeOptions,
): NodeHostCommandHandler {
  return async (args) => readWorkspaceFile(args)
}
