// `rg_search_workspace` 的编排：入参收窄 → spawn → 并发读 stdout/stderr → 拼结果
// ---------------------------------------------------------------------------
// 对齐 Rust 的 `rg_search_workspace_blocking`。**除极少数「几乎不可能发生」的基础设施故障外，
// 这条命令从不 reject**——query 为空、workspace root 解析失败、目标路径越界、globs 非法、
// rg 缺失，全部落进 `Ok(failed_result(err))`（Rust 侧原文），即 `ok:false` 的正常返回值而不是
// Promise rejection。这里逐条保留同样的软失败语义：每一步用 try/catch 包一层，
// 失败就地转 `failedRgResult`，不向上抛。
//
// stdout 与 stderr 的读取**必须并发**、不能先读完 stdout 再读 stderr：stderr 若不被排空，
// rg 写满那根管道的 OS 缓冲区后会阻塞在 write 上，进而卡住整个子进程（包括我们正在等的
// stdout）。Rust 侧为此专门起一个线程去 drain stderr；Node 侧不需要额外线程——两个
// `await` 目标各自发起后互不阻塞，靠事件循环自然并发，只要不写成「先 await 一个、再 await
// 另一个」就行。顺序保留 Rust 的读法：先拿 parseRgStdout 的结果、再等退出码、最后取 stderr
// （届时 stderr 的 drain 大概率已经跑完，跟 Rust 那边线程早于 join 完工是一个道理）。

import { createInterface } from 'node:readline'
import { errorText, readCappedDrain, resolveWorkspaceRoot } from '../common'
import {
  DEFAULT_RG_CONTEXT_LINES,
  DEFAULT_RG_MAX_MATCHES,
  MAX_RG_CONTEXT_LINES,
  MAX_RG_MATCHES,
  MAX_RG_STDERR_CHARS,
} from './constants'
import { normalizeGlobs } from './normalizeGlobs'
import {
  normalizeCaseSensitive,
  normalizeContextLines,
  normalizeMaxMatches,
  normalizeQuery,
  normalizeRegex,
} from './normalizeRgInput'
import { normalizeRgTargetPath } from './normalizeRgTargetPath'
import { parseRgStdout } from './parseRgStdout'
import { spawnRg, type RgChildProcess } from './spawnRg'
import { failedRgResult, type RgSearchResult } from './types'
import type { NodeHostInvokeOptions } from '../../hostOptions'
import type { NodeHostCommandHandler } from '../../routeTable'

/** 等价 Rust 的 `child.wait()`：等子进程真正退出，取退出码。`code ?? 1` 对齐 `unwrap_or(1)`。 */
function waitForExit(child: RgChildProcess): Promise<number> {
  return new Promise((resolve) => {
    child.once('close', (code) => resolve(code ?? 1))
  })
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' ? value : undefined
}

async function rgSearchWorkspace(args: Record<string, unknown>): Promise<RgSearchResult> {
  const query = normalizeQuery(args.query)
  if (query === '') return failedRgResult('query must be a non-empty string')

  let root: string
  try {
    root = await resolveWorkspaceRoot(stringArg(args, 'workspace_root'))
  } catch (error) {
    return failedRgResult(errorText(error))
  }

  // 判存在只看值，不用 `'allow_external_paths' in args`：见 commandArgs.ts 顶部的 undefined 陷阱。
  const allowExternalPaths = args.allow_external_paths === true

  let target: string
  try {
    target = await normalizeRgTargetPath(root, args.path, allowExternalPaths)
  } catch (error) {
    return failedRgResult(errorText(error))
  }

  let globs: string[]
  try {
    globs = normalizeGlobs(args.globs)
  } catch (error) {
    return failedRgResult(errorText(error))
  }

  const contextLines = normalizeContextLines(
    args.context_lines,
    DEFAULT_RG_CONTEXT_LINES,
    MAX_RG_CONTEXT_LINES,
  )
  const maxMatches = normalizeMaxMatches(args.max_matches, DEFAULT_RG_MAX_MATCHES, MAX_RG_MATCHES)
  const regex = normalizeRegex(args.regex)
  const caseSensitive = normalizeCaseSensitive(args.case_sensitive)

  let child: RgChildProcess
  try {
    child = await spawnRg({ root, target, query, regex, caseSensitive, globs, contextLines })
  } catch (error) {
    return failedRgResult(errorText(error))
  }

  const exitPromise = waitForExit(child)
  const stderrPromise = readCappedDrain(child.stderr, MAX_RG_STDERR_CHARS)
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })

  const parsed = await parseRgStdout(rl, root, contextLines, maxMatches, () => {
    child.kill()
  })
  rl.close()

  const exitCode = await exitPromise
  const stderr = await stderrPromise

  const ok = parsed.truncated || exitCode === 0 || exitCode === 1
  return {
    ok,
    matches: parsed.matches,
    truncated: parsed.truncated || stderr.truncated,
    exitCode,
    stderr: stderr.text,
  }
}

export function createRgSearchWorkspaceHandler(
  _options: NodeHostInvokeOptions,
): NodeHostCommandHandler {
  return async (args) => rgSearchWorkspace(args)
}
