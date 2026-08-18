// `get_workspace_diff` 的主流程：解析参数 → 跑 status / stat / diff → 汇总结果
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_git_pipeline.rs。
//
// ═══ 两类失败必须分开 ═══
//   · **结构化失败**（root 解析不了、pathspec 越界、base 不合法、git 说这里不是仓库）——
//     返回一个 `exit_code != 0` 的正常结果，病因写在 `stderr` 里。调用方（core 的
//     `getWorkspaceDiff`）本来就要展示 git 的退出码与 stderr，这类失败对它是同一种东西。
//   · **抛错**（git 起不来、管道读不动）——命令整个 reject。core 那边会 catch 成
//     `get_workspace_diff failed: ...`。宿主环境坏了和「这次 diff 没结果」不是一回事。
//   Rust 用 `Ok(failed_result(..))` 与 `?` 表达同一组区分，逐条对齐。
//
// ═══ 返回值的键是 snake_case ═══
// Rust 的 `WorkspaceDiffResult` 上没有 `rename_all`，serde 原样序列化字段名；`Option` 为 None
// 时给的是 `null`（没有 skip_serializing_if）。core 的 normalizeResult 两种写法都认
// （`raw.statusShort ?? raw.status_short`），但两个宿主对同一次调用应当给出同一份 JSON。

import { errorText, resolveWorkspaceRoot } from '../common'
import type { WorkspaceDiffRequest } from './diffRequest'
import { diffArgs, diffNameOnlyArgs, normalizeBase, normalizeMaxDiffChars, statusArgs } from './gitArgs'
import { runGit, runGitDiffCapped } from './gitExec'
import { normalizePathspecs } from './gitPathspecs'

/** 与 Rust `WorkspaceDiffResult` 逐字段对应的线上形状。 */
export interface WorkspaceDiffPayload {
  base: string | null
  status_short: string
  stat: string | null
  diff: string
  changed_files: string[]
  truncated: boolean
  exit_code: number
  stderr: string
}

export async function getWorkspaceDiff(
  request: WorkspaceDiffRequest,
): Promise<WorkspaceDiffPayload> {
  const maxDiffChars = normalizeMaxDiffChars(request.maxDiffChars)
  const includeStat = request.includeStat ?? true
  const staged = request.staged ?? false

  let root: string
  let pathspecs: string[]
  let base: string | undefined
  try {
    // root 不走宿主进程的裸 cwd：显式传入优先，其次 git 仓库根，都得不到就拒绝服务。
    // 这个值是所有路径限制的可信根，它一旦是 `/`，confinement 就等于没有。
    root = await resolveWorkspaceRoot(request.workspaceRoot)
    pathspecs = await normalizePathspecs(request.paths, root)
    base = normalizeBase(request.base)
  } catch (error) {
    return failedResult(errorText(error))
  }

  if (base !== undefined) {
    const unresolved = await verifyBaseCommit(root, base)
    if (unresolved !== undefined) return failedResult(unresolved)
  }

  // 调用方给了 paths 做聚焦 review 时，status 也要按同一批 pathspec 收窄，否则
  // status_short / changed_files 会混入无关文件，与下面已收窄的 diff/stat 自相矛盾。
  const status = await runGit(root, statusArgs(pathspecs))
  if (status.exitCode !== 0) {
    // 「这里不是 git 仓库」「仓库损坏」都落在这条：git 自己的退出码与 stderr 原样交回去，
    // 别翻译成一句我们自己编的话——调用方要展示的就是 git 说了什么。
    return {
      base: base ?? null,
      status_short: status.stdout,
      stat: null,
      diff: '',
      changed_files: [],
      truncated: false,
      exit_code: status.exitCode,
      stderr: status.stderr,
    }
  }

  const stderrParts = [status.stderr]
  let statExitCode: number | undefined
  let stat: string | null = null
  if (includeStat) {
    const statOutput = await runGit(root, diffArgs(staged, base, true, pathspecs))
    if (statOutput.exitCode !== 0) statExitCode = statOutput.exitCode
    stderrParts.push(statOutput.stderr)
    stat = statOutput.stdout
  }

  const diffOutput = await runGitDiffCapped(
    root,
    diffArgs(staged, base, false, pathspecs),
    maxDiffChars,
  )
  // diff 的失败优先报；diff 成功而 stat 失败时也不能报成功，否则调用方看到一份缺了摘要的
  // 「正常」结果。
  const exitCode = diffOutput.exitCode !== 0 ? diffOutput.exitCode : (statExitCode ?? diffOutput.exitCode)
  stderrParts.push(diffOutput.stderr)

  const changedFiles = await collectChangedFiles({
    root,
    staged,
    base,
    pathspecs,
    statusShort: status.stdout,
    stderrParts,
  })

  return {
    base: base ?? null,
    status_short: status.stdout,
    stat,
    diff: diffOutput.text,
    changed_files: changedFiles,
    truncated: diffOutput.truncated,
    exit_code: exitCode,
    stderr: joinStderr(stderrParts),
  }
}

/**
 * 确认 base 真的解析成一个 commit；解析不了时返回给调用方看的那句话，成功返回 undefined。
 *
 * 这道校验不只是「早点报错更友好」：`git diff <base>` 里的 `<base>` 若不是 rev，git 会把它
 * 当成 **pathspec**。少了这一步，一个恰好是仓库内路径的 base 会让「对比某个提交」静默变成
 * 「只看某个文件」。`--end-of-options` 再兜一层，保证这个值永远不被当作选项解析
 * （normalizeBase 已经拒了以 `-` 开头的输入，这是第二道）。
 */
async function verifyBaseCommit(root: string, base: string): Promise<string | undefined> {
  const verify = await runGit(root, [
    'rev-parse',
    '--verify',
    '--quiet',
    '--end-of-options',
    `${base}^{commit}`,
  ])
  if (verify.exitCode === 0) return undefined
  const detail = verify.stderr === '' ? '' : `: ${verify.stderr.trim()}`
  return `git diff base \`${base}\` does not resolve to a commit${detail}`
}

interface ChangedFilesInput {
  root: string
  staged: boolean
  base: string | undefined
  pathspecs: readonly string[]
  statusShort: string
  stderrParts: string[]
}

/**
 * 变更文件清单。给了 base 就得另跑一次 `--name-only`——status 报的是工作树相对 HEAD 的改动，
 * 与「相对 base 的改动」是两码事。没给 base 时直接解析 status，省一次 git 调用。
 */
async function collectChangedFiles(input: ChangedFilesInput): Promise<string[]> {
  if (input.base === undefined) return parseChangedFiles(input.statusShort)

  const names = await runGit(
    input.root,
    diffNameOnlyArgs(input.staged, input.base, input.pathspecs),
  )
  if (names.exitCode !== 0) {
    // 清单拿不到不算整次调用失败（diff 正文已经有了），但 stderr 要留痕。
    input.stderrParts.push(names.stderr)
    return []
  }
  return splitLines(names.stdout).filter((path) => path !== '')
}

function failedResult(stderr: string): WorkspaceDiffPayload {
  return {
    base: null,
    status_short: '',
    stat: null,
    diff: '',
    changed_files: [],
    truncated: false,
    exit_code: 1,
    stderr,
  }
}

/**
 * 从 `git status --short` 解析变更文件。
 *
 * 前三列是状态码加一个空格（恒为 ASCII），所以按第 3 个字符切没有多字节问题。
 * 重命名行形如 `R  old -> new`，取箭头右边的新路径。
 */
function parseChangedFiles(statusShort: string): string[] {
  const files: string[] = []
  for (const line of splitLines(statusShort)) {
    if (line.length <= 3) continue
    const path = line.slice(3).trim()
    if (path === '') continue
    const arrow = path.lastIndexOf(' -> ')
    files.push(arrow === -1 ? path : path.slice(arrow + 4))
  }
  return files
}

/** 等价 Rust 的 `str::lines()`：按 `\n` 切、去掉每行结尾的 `\r`、末尾的空行不算一行。 */
function splitLines(text: string): string[] {
  const parts = text.split('\n')
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop()
  return parts.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
}

/** 多段 stderr 合成一段：空段丢掉，其余用换行拼接。 */
function joinStderr(parts: readonly string[]): string {
  return parts.filter((part) => part !== '').join('\n')
}
