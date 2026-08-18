// 一个补丁操作的纯规则：入参怎么校验、暂存状态该变成什么
// ---------------------------------------------------------------------------
// 等价移植 apps/desktop/src/workspace_patch_stage.rs 里 `stage_operation` 的四个分支，**只留纯
// 的那部分**：不解析路径、不读磁盘、不认识暂存表。IO 那半边在 stage.ts。
//
// 拆这一刀是为了 W16 的跨语言对拍：Rust 的补丁语义能不能等价复现，判据是「同一个
// (state, operation) 进去，出来的 state 与错误文案逐字相同」——那是纯函数才能被 fixture 直接喂
// 的形状，有临时目录树掺在里面就只能靠人眼比对了。
//
// 【顺序是契约的一部分，别合并这两个导出】
// Rust 每个分支都是「先校验文本入参，再解析路径，再读磁盘，最后动状态」。所以路径既坏、内容
// 又超限时，报的是**内容超限**。合成一个函数就必然把路径解析挪到校验之前，那条边角当场翻转，
// 而它不会有任何测试之外的症状。stage.ts 严格按 validate → resolve → load → next 调。

import { verifyStagedGuard } from './guard'
import { validateFileText, validateNonEmptyTextInput, validateTextInput } from './limits'
import type { PatchFileState, PatchOperation } from './types'

/**
 * 只看操作自身的入参校验（大小、二进制、`oldText` 非空、`expectedReplacements` 为正）。
 * **必须在路径解析之前调**，见文件头。
 */
export function validatePatchOperationInput(operation: PatchOperation): void {
  switch (operation.type) {
    case 'add_file':
      validateTextInput('content', operation.content)
      return
    case 'delete_file':
      if (operation.oldContent !== undefined) validateTextInput('oldContent', operation.oldContent)
      return
    case 'replace':
      validateNonEmptyTextInput('oldText', operation.oldText)
      validateTextInput('newText', operation.newText)
      if (operation.expectedReplacements !== undefined && operation.expectedReplacements <= 0) {
        throw new Error('expectedReplacements must be greater than 0')
      }
      return
    case 'overwrite_file':
      validateTextInput('content', operation.content)
      if (operation.oldContent !== undefined) validateTextInput('oldContent', operation.oldContent)
      return
  }
}

/**
 * 把一个操作作用到该文件的暂存状态上，返回**新的**状态；不合法则抛错（文案与桌面端逐字一致）。
 *
 * 返回新对象而不是就地改：暂存表的写入点因此只有 stage.ts 一处，规则这边没有「改了一半又抛错，
 * 留下半改的状态」的可能。
 */
export function nextFileState(
  state: PatchFileState,
  operation: PatchOperation,
): PatchFileState {
  switch (operation.type) {
    case 'add_file':
      return stageAdd(state, operation)
    case 'delete_file':
      return stageDelete(state, operation)
    case 'replace':
      return stageReplace(state, operation)
    case 'overwrite_file':
      return stageOverwrite(state, operation)
  }
}

/**
 * add_file 语义是「创建新文件」，两条守卫都要走（Rust 侧的 P2 注释在这里一字不落地成立）：
 *   · `current !== null`：当前内容还在（磁盘原有 or 本批已 add），不能重复新建。
 *   · `initial !== null`：本批开始时磁盘上就已存在。哪怕中途被 delete_file 把 current 置空，
 *     也仍然拒绝 add——否则 delete+add 同路径就能绕过 overwrite_file 对已存在文件要求
 *     oldContent 的守卫，静默整文件替换。改已存在文件的内容必须走 overwrite_file。
 *   合法场景不受影响：本批内 新建 → 删 → 再建 同一路径，initial 始终为 null，仍放行。
 */
function stageAdd(
  state: PatchFileState,
  operation: Extract<PatchOperation, { type: 'add_file' }>,
): PatchFileState {
  if (state.current !== null) throw new Error('file already exists')
  if (state.initial !== null) {
    throw new Error('file already exists on disk; use overwrite_file to replace an existing file')
  }
  return {
    initial: state.initial,
    current: operation.content,
    executable: pickExecutable(state, operation.executable),
  }
}

function stageDelete(
  state: PatchFileState,
  operation: Extract<PatchOperation, { type: 'delete_file' }>,
): PatchFileState {
  const current = state.current
  if (current === null) throw new Error('file does not exist')
  verifyStagedGuard(current, operation.oldContent, operation.expectedContentHash)
  return { initial: state.initial, current: null, executable: state.executable }
}

function stageReplace(
  state: PatchFileState,
  operation: Extract<PatchOperation, { type: 'replace' }>,
): PatchFileState {
  const current = state.current
  if (current === null) throw new Error('file does not exist')

  // `split(oldText).length - 1` = **不重叠、从左到右**的出现次数，与 Rust `str::matches` 同款
  // （`"aaa"` 里的 `"aa"` 两边都数 1 个）。`oldText` 为空串已被 validateNonEmptyTextInput 拒掉，
  // 所以这里不会遇到「空串匹配 n+1 次」。
  const segments = current.split(operation.oldText)
  const replacementCount = segments.length - 1
  if (replacementCount === 0) throw new Error('oldText was not found')

  const expected = operation.expectedReplacements ?? 1
  if (replacementCount !== expected) {
    throw new Error(
      `replacement count mismatch: expected ${expected}, found ${replacementCount}`,
    )
  }

  // `split().join()` 而不是 `replaceAll`：后者会把 newText 里的 `$&` / `$1` / `$'` 当成替换
  // 模式展开，模型给的正文里出现这几个字符就会被静默改写。Rust 的 `str::replace` 是字面替换。
  const next = segments.join(operation.newText)
  validateFileText('resulting file content', next)
  return { initial: state.initial, current: next, executable: state.executable }
}

function stageOverwrite(
  state: PatchFileState,
  operation: Extract<PatchOperation, { type: 'overwrite_file' }>,
): PatchFileState {
  if (state.current !== null) {
    // 覆盖已存在的文件仍然要求先读过；expectedContentHash 是证明这件事的便宜写法。
    if (operation.oldContent === undefined && operation.expectedContentHash === undefined) {
      throw new Error(
        'oldContent or expectedContentHash is required when overwriting an existing file',
      )
    }
    verifyStagedGuard(state.current, operation.oldContent, operation.expectedContentHash)
  }
  return {
    initial: state.initial,
    current: operation.content,
    executable: pickExecutable(state, operation.executable),
  }
}

/**
 * 只有**显式给了** executable 的操作才改这个字段（Rust 的 `if executable.is_some()`）。
 * `false` 也是显式给了——它的意思是「去掉执行位」，与「没提过」不是一回事。
 */
function pickExecutable(state: PatchFileState, requested: boolean | undefined): boolean | null {
  return requested === undefined ? state.executable : requested
}
