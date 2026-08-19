// workspace 各域共用的零件：路径底座、原子写、带上限的增量读、变更摘要与行级 diff
// ---------------------------------------------------------------------------
// **本目录不产出任何命令 handler**——它在 commandNames.ts 的 `NODE_HOST_COMMANDS_BY_DOMAIN`
// 里是零命令的共用零件目录，理由与 Rust 侧 workspace_common.rs 的文件头一致：把跨模块共享的
// 逻辑抽出来，免得 read/write/patch/delete/git 各写各的、逐渐漂移。Rust 侧原本就出现过同一条
// confinement 判定在六个文件里各抄一遍的局面（workspace_read_paths / workspace_write_target_path
// / workspace_patch_path / workspace_delete / workspace_path_ops / workspace_rg），Node 侧从第一天
// 就只有一份——**唯一的例外是 `changeSummary.ts` / `lineDiff.ts`**：write（W7）与 patch（W13）
// 两张卡并行开工时都需要 `compute_change_summary` / `diff_lines`，谁都不敢在本目录建同名文件
// 抢跑（后落笔的会静默盖掉先落笔的），所以各自在自己的域里落了一份，等两卡都提交后才合并回
// 这里；具体经过见那两个文件的文件头。
//
// 规格是 apps/desktop/src/workspace_common.rs（已随 T1 删除）及上列那几份路径文件，
// **这是等价移植不是重新设计**；今天本目录就是这套规格在仓库里的唯一载体。
// 唯一有意偏离的一处记在这里，别让它散在代码里：
//
//   **UTF-8 分块解码**。Rust 对每个读到的块单独跑 `String::from_utf8_lossy`，于是一个多字节
//   字符被块边界（8 KiB）劈开时，两半各自变成替换字符 `�`——中文输出只要超过 8 KiB 就有
//   大约 2/3 的概率在边界处坏掉一个字。Node 侧用 `StringDecoder`，它把块尾不完整的序列留到
//   下一块，因此解出来的是那个字本身。这是**修好了 Rust 的一个 bug**，不是换了个口径：对
//   合法 UTF-8 且未被劈开的输入，两边逐字节相同；被劈开时 Node 给的是正确结果。当年 W16/W17
//   的跨语言对拍因此**不构造跨块的多字节字符**（`../../fixtures/README.md` 记着这条豁免）。
//   Rust 侧已随 T1 删除，这个偏离今天没有对照物了——留着这段是因为它解释了这里为什么用
//   `StringDecoder` 而不是逐块 `toString()`，那个选择仍然必须保持。
//
// 其余一切（错误文案、上限语义、权限位处理、临时文件命名、`..` 的拒法）都与移植来源逐条对齐；
// 错误文案刻意保留英文原文——它们就以这个样子出现在模型可见的工具结果里，core 与前端按它写死。

export { atomicWrite } from './atomicWrite'
export { computeChangeSummary } from './changeSummary'
export type { FileChangeSummary } from './changeSummary'
export { countCodePoints, takeCodePoints } from './codePoints'
export { relativeToRoot, toSlashPath } from './displayPath'
export { errorText } from './errorText'
export { diffLines, diffMarker, splitLines } from './lineDiff'
export type { DiffEdit, DiffTag } from './lineDiff'
export {
  hasNulByte,
  hasParentSegment,
  isFilesystemRoot,
  isWithinRoot,
  joinRequestedPath,
  normalizeLexically,
} from './pathContainment'
export { readCappedDrain, readCappedStop } from './readCapped'
export type { ByteSource, CappedRead } from './readCapped'
export { resolveWorkspaceRoot } from './resolveWorkspaceRoot'
export type { ResolveWorkspaceRootOptions } from './resolveWorkspaceRoot'
export { resolveExistingWorkspacePath, resolveWorkspaceTargetPath } from './resolveWorkspacePath'
export type { ResolvedWorkspacePath, ResolveExistingPathOptions } from './resolveWorkspacePath'
