// 把未经校验的入参收窄成补丁操作
// ---------------------------------------------------------------------------
// 对应 apps/desktop/src/workspace_patch_operation.rs（已随 T1 删除）那个 `#[derive(Deserialize)]` 枚举——Rust
// 侧这一步是 serde 白干的，Node 侧没有那道关卡：路由表交给 handler 的是
// `Record<string, unknown>`，而这条命令要挂在 HTTP 后面，载荷来自浏览器。
//
// 【失败的位置与 Rust 一致：整条命令失败，不是某一条操作被拒】
// serde 反序列化失败时 Tauri 根本不会进入 handler，模型看到的是命令级错误。所以这里也**抛错**
// 而不是产出一条 `rejected[]`——`rejected[]` 的语义是「这条操作的语义不成立」（文件不存在、
// 守卫不匹配），把「你传的 JSON 不对」混进去会让模型以为改改内容重试就行。
//
// 【文案用中文】这些失败在 Rust 侧的对应物是 serde 自己的英文报错（`missing field \`content\``
// 之类），逐字复现既做不到也没意义。按全线纪律：**没有 Rust 对应物的失败用中文**，有对应物的
// （限额、守卫、路径）一律保留英文原文。
//
// 【Rust 的两个投影函数在 TS 里不需要】
// `operation_name` / `operation_path` 是为了绕开 Rust 枚举必须 match 才能取字段；TS 这边是带
// 判别键的联合类型，`operation.type` 就是 Rust 那四个名字（`add_file` / `delete_file` /
// `replace` / `overwrite_file`），`operation.path` 四个变体都有。W13 拼 `rejected[]` 时直接取字段。

import type { PatchOperation } from './types'

const OPERATION_TYPES = ['add_file', 'delete_file', 'replace', 'overwrite_file'] as const

type OperationOf<T extends PatchOperation['type']> = Extract<PatchOperation, { type: T }>
/** 带乐观守卫的两个变体（delete_file / overwrite_file），两个可选字段完全同名同义。 */
type GuardedOperation = OperationOf<'delete_file'> | OperationOf<'overwrite_file'>

/** 收窄整个 `operations` 数组。任何一条不合法都直接抛错——整批不执行。 */
export function parsePatchOperations(raw: unknown): PatchOperation[] {
  if (!Array.isArray(raw)) throw new Error('operations 必须是数组')
  return raw.map((entry, index) => parsePatchOperation(entry, index))
}

/** 收窄一条操作。`index` 只用于错误文案，让模型知道是第几条出了问题。 */
export function parsePatchOperation(raw: unknown, index: number): PatchOperation {
  if (!isRecord(raw)) throw new Error(`operations[${index}] 必须是对象`)
  const type = raw.type
  if (typeof type !== 'string' || !isOperationType(type)) {
    throw new Error(`operations[${index}].type 必须是 ${OPERATION_TYPES.join(' / ')} 之一`)
  }

  const path = requireString(raw, 'path', index)
  switch (type) {
    case 'add_file': {
      const operation: OperationOf<'add_file'> = {
        type,
        path,
        content: requireString(raw, 'content', index),
      }
      const executable = optionalBoolean(raw, 'executable', index)
      if (executable !== undefined) operation.executable = executable
      return operation
    }
    case 'delete_file': {
      const operation: OperationOf<'delete_file'> = { type, path }
      assignGuards(operation, raw, index)
      return operation
    }
    case 'replace': {
      const operation: OperationOf<'replace'> = {
        type,
        path,
        oldText: requireString(raw, 'oldText', index),
        newText: requireString(raw, 'newText', index),
      }
      const expected = optionalInteger(raw, 'expectedReplacements', index)
      if (expected !== undefined) operation.expectedReplacements = expected
      return operation
    }
    case 'overwrite_file': {
      const operation: OperationOf<'overwrite_file'> = {
        type,
        path,
        content: requireString(raw, 'content', index),
      }
      assignGuards(operation, raw, index)
      const executable = optionalBoolean(raw, 'executable', index)
      if (executable !== undefined) operation.executable = executable
      return operation
    }
  }
}

/** `oldContent` / `expectedContentHash` 两个变体共用（delete_file 与 overwrite_file）。 */
function assignGuards(
  operation: GuardedOperation,
  raw: Record<string, unknown>,
  index: number,
): void {
  const oldContent = optionalString(raw, 'oldContent', index)
  if (oldContent !== undefined) operation.oldContent = oldContent
  const expectedContentHash = optionalString(raw, 'expectedContentHash', index)
  if (expectedContentHash !== undefined) operation.expectedContentHash = expectedContentHash
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isOperationType(value: string): value is PatchOperation['type'] {
  return (OPERATION_TYPES as readonly string[]).includes(value)
}

function requireString(raw: Record<string, unknown>, key: string, index: number): string {
  const value = raw[key]
  if (typeof value !== 'string') throw new Error(`operations[${index}].${key} 必须是字符串`)
  return value
}

/**
 * 可选字段：`undefined` 与 `null` 都算「没给」。
 *
 * 两个都要认：serde 的 `Option<T>` 收 `null`，而 core 的 `toTauriInput` 整份对象字面量返回、
 * 可选项无值时**键存在且为 undefined**（走 HTTP 时 `JSON.stringify` 又会把它丢掉）。所以判存在
 * 只能看值，不能用 `'key' in raw`——那会让同一份入参在进程内与 HTTP 两条路上给出不同结果。
 */
function optionalString(
  raw: Record<string, unknown>,
  key: string,
  index: number,
): string | undefined {
  const value = raw[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`operations[${index}].${key} 必须是字符串`)
  return value
}

function optionalBoolean(
  raw: Record<string, unknown>,
  key: string,
  index: number,
): boolean | undefined {
  const value = raw[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw new Error(`operations[${index}].${key} 必须是布尔值`)
  return value
}

/** Rust 那边是 `Option<i64>`，小数与数字字符串都会被 serde 拒；这里同样只收整数。 */
function optionalInteger(
  raw: Record<string, unknown>,
  key: string,
  index: number,
): number | undefined {
  const value = raw[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`operations[${index}].${key} 必须是整数`)
  }
  return value
}
