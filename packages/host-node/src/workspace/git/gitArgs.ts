// git 子命令 argv 的构造与请求参数归一化 —— 这就是那道「参数白名单」
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_git_args.rs（配套测试 workspace_git_args_tests.rs）（已随 T1 删除）。
// **照搬，不重新设计**：下面每一条拒绝都对应一条具体的注入/降级路径，逐条注在原处。
//
// ═══ 白名单是「构造式」的，不是「过滤式」的 ═══
// 这里从不接受调用方给的 flag 再去判它安不安全（那种白名单永远漏，git 的参数面太大：
// `--output=<file>` 能写任意文件、`--ext-diff` 能重新打开外部 diff driver、全局 `-c
// core.pager=...` / `-c diff.external=...` 能变成任意命令执行）。argv 的**每一个 flag 都是本
// 文件里的字面量**，调用方只能influence两处值：
//
//   1. `base` —— 一个 ref/commit。normalize_base 之后它不可能以 `-` 开头，因此永远不会被 git
//      的选项解析器当成 flag；它也进不了「flag 的值」的位置（argv 里它自成一个元素）。
//   2. `paths` —— 一律经 gitPathspecs.ts 收窄成 workspace 内的相对路径，并且**只出现在 `--`
//      之后**，git 从那里开始不再解析选项。
//
// 没有 shell 参与（`spawn` 不带 `shell`），所以「参数里带空格/引号/分号」这一整类拆词注入在
// 这条路上根本不存在——空格与控制字符的拒绝另有理由，见 normalizeBase。
//
// ═══ P1：堵死外部 diff / textconv driver ═══
// 「只读 review」绝不能 spawn 外部命令，所以同一件事做三遍、任何来源都盖不过：
//   · `-c diff.external=`（全局选项，必须排在子命令 `diff` **之前**）用空值覆盖仓库 config；
//   · `--no-ext-diff` / `--no-textconv`（diff 子命令选项，排在 `diff` 之后）；
//   · env `GIT_EXTERNAL_DIFF=""`（在 gitExec.ts 里施加）。
// 三重叠加不是冗余：config 能被仓库里的 `.git/config` 设、env 能被父进程设、命令行 flag 是最后
// 一道。少任何一层，一个被 clone 下来的恶意仓库就能在「看一眼 diff」时执行命令。

import { hasWhitespaceOrControl, trimUnicodeWhitespace } from './unicodeWhitespace'

/** 未指定 / 指定为 0 时的 diff 字符上限。与 core 的同名常量取同一个值（本包不引 core 的运行时）。 */
export const DEFAULT_MAX_DIFF_CHARS = 20_000
/** 调用方能要到的上限天花板。 */
export const MAX_DIFF_CHARS = 100_000

/**
 * 归一化 `base`（要对比的 ref/commit）。无效时**抛错**，由流水线转成结构化失败
 * （Rust 侧是 `Result<Option<String>, String>` + `match` 转 failed_result，等价）。
 *
 * 三条拒绝各自挡什么：
 *   · **空** —— 空串会变成 argv 里一个空元素，git 会把它当成一个（空的）rev 或 pathspec，
 *     报出与调用方意图无关的错。当场说清楚更好。
 *   · **以 `-` 开头** —— 这条是真正的注入防线。base 出现在 `git ... diff <flags> <base>` 的
 *     位置上，`--` 之前，所以 git 仍在解析选项：`--output=/tmp/x` 会让「只读」的 diff 往任意
 *     路径写文件，`--ext-diff` 会把上面 P1 那三重防护里的命令行那一层原地掀掉。
 *   · **含空白或控制字符** —— 没有 shell，所以它不是拆词防线；它挡的是另外两件事：
 *     ① 合法 ref 本来就不允许这些字符（`git check-ref-format` 禁空格与 ASCII 控制符），
 *        在这里拒等于把「不可能成功」的输入挡在起跑线，而不是让它一路跑到 git 再回一句晦涩的话；
 *     ② base 会原样进入返回值 `base` 字段与拼接出来的 stderr，含换行的值能在日志/面板里伪造出
 *        额外的一行。
 *
 * 注意范围语法（`HEAD~3..HEAD`）在这里**不会**被拒，但流水线随后的
 * `rev-parse --verify --end-of-options <base>^{commit}` 会拒——那道校验的正事是确认 base 真是
 * 一个 commit：漏掉它的话，一个恰好是仓库内路径的 base 会被 `git diff` 静默当成 pathspec，
 * 于是「对比某个提交」变成了「只看某个文件」，而调用方毫不知情。
 */
export function normalizeBase(base: string | undefined): string | undefined {
  if (base === undefined) return undefined
  const trimmed = trimUnicodeWhitespace(base)
  if (trimmed === '') throw new Error('git diff base cannot be empty')
  if (trimmed.startsWith('-') || hasWhitespaceOrControl(trimmed)) {
    throw new Error(
      'git diff base must be a ref or commit without leading `-`, whitespace, or control characters',
    )
  }
  return trimmed
}

/**
 * 归一化 diff 字符上限：给了正数就取 `min(值, MAX_DIFF_CHARS)`，其余（未给 / 0）取默认值。
 * 上限是防大 diff 撑爆进程的，所以调用方只能往下要，不能往上加。
 */
export function normalizeMaxDiffChars(maxDiffChars: number | undefined): number {
  if (maxDiffChars !== undefined && maxDiffChars > 0) return Math.min(maxDiffChars, MAX_DIFF_CHARS)
  return DEFAULT_MAX_DIFF_CHARS
}

/**
 * `git status --short`，可选按 pathspec 收窄。
 *
 * **不带 `--no-ext-diff` / `--no-textconv`**：那是 diff 专属选项，status 收到会直接报错。
 * status 侧的外部命令兜底靠 gitExec.ts 的 env，参数层保持干净（对应 Rust 的
 * `status_args_have_no_diff_only_flags` 测试）。
 */
export function statusArgs(paths: readonly string[]): string[] {
  const args = ['status', '--short']
  if (paths.length > 0) args.push('--', ...paths)
  return args
}

/** 正文 diff（`stat` 为真时改出 `--stat` 摘要）。 */
export function diffArgs(
  staged: boolean,
  base: string | undefined,
  stat: boolean,
  paths: readonly string[],
): string[] {
  return diffArgsWithFormat(staged, base, stat ? '--stat' : undefined, paths)
}

/** 只要文件名清单（指定了 base 时用它算 changed_files）。 */
export function diffNameOnlyArgs(
  staged: boolean,
  base: string | undefined,
  paths: readonly string[],
): string[] {
  return diffArgsWithFormat(staged, base, '--name-only', paths)
}

/**
 * diff 系列 argv 的唯一构造点。三种形态（正文 / `--stat` / `--name-only`）共用它，
 * 免得 P1 那三件套在某一种形态上被漏掉——漏掉是静默的，只有恶意仓库才看得出差别。
 */
function diffArgsWithFormat(
  staged: boolean,
  base: string | undefined,
  format: string | undefined,
  paths: readonly string[],
): string[] {
  const args = ['-c', 'diff.external=', 'diff', '--no-ext-diff', '--no-textconv']
  if (staged) args.push('--cached')
  if (format !== undefined) args.push(format)
  if (base !== undefined) args.push(base)
  // pathspec 一律在 `--` 之后：git 从这里起不再解析选项，路径长什么样都不会变成 flag。
  if (paths.length > 0) args.push('--', ...paths)
  return args
}
